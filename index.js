import express from 'express';
import * as fs from 'fs';
import fetch from 'node-fetch';
import * as url from 'url';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import mime from 'mime';
import cors from 'cors';
import http from 'http'; // Import http module for creating custom server

const app = express();
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

// Initial port for the main Express app
const MAIN_SERVER_PORT = 5000;

// Base port for dynamically created proxy servers. Will increment for each new proxy.
let currentProxyPort = 5001;

// Middleware for parsing JSON and enabling CORS
app.use(express.json());
app.use(cors({ origin: '*' }));

// Serve static files from the 'content' directory
app.use(express.static(path.join(__dirname, './content/'), { extensions: ['html'] }));

// POST endpoint to initiate a website download
app.post('/form', async (req, res) => {
  const gameUrl = req.body.url;

  if (!gameUrl) {
    // If no gameUrl is provided, return a bad request error
    return res.status(400).json({ error: true, errorMsg: 'Game URL is missing.' });
  }

  // --- Determine a unique download directory for this session ---
  let downloadBaseDir = './downloads';
  let counter = 0;
  let currentDownloadDir = downloadBaseDir;

  // Loop to find an available directory name (downloads, downloads-1, downloads-2, etc.)
  while (fs.existsSync(currentDownloadDir)) {
    counter++;
    currentDownloadDir = `${downloadBaseDir}-${counter}`;
  }

  // Ensure the base download directory exists
  try {
    fs.mkdirSync(currentDownloadDir, { recursive: true });
    console.log(`New download session initiated. Files will be saved to: ${currentDownloadDir}`);
  } catch (e) {
    console.error(`Error creating base download directory ${currentDownloadDir}:`, e);
    return res.status(500).json({ error: true, errorMsg: 'Could not create download directory.' });
  }

  // --- Create a new Express app instance for this specific proxy ---
  const blazeProxy = express();
  blazeProxy.use(cors({ origin: '*' })); // Enable CORS for the proxy

  const paths = []; // To store paths of downloaded files within this session

  // --- Create an HTTP server for this proxy instance ---
  const blazeProxyServer = http.createServer(blazeProxy);

  // --- Create a WebSocketServer for this specific proxy instance ---
  const proxyWss = new WebSocketServer({ server: blazeProxyServer });

  // Handle WebSocket connections for this proxy
  proxyWss.on('connection', (conn) => {
    console.log(`WebSocket connection established for proxy in ${currentDownloadDir}`);

    // Message handler for this specific WebSocket connection
    conn.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.action === 'stop' || data.action === 'done') {
          // Send confirmation that the action is processed
          conn.send(
            JSON.stringify({
              type: 'action',
              action: 'closed',
              timestamp: new Date(),
            })
          );

          if (data.action === 'done') {
            // If action is 'done', send back the list of downloaded paths
            conn.send(
              JSON.stringify({
                type: 'data',
                data: paths,
                timestamp: new Date(),
              })
            );
          }

          // Clean up the specific download directory for this session after a delay
          setTimeout(() => {
            fs.rmSync(currentDownloadDir, { recursive: true, force: true });
            console.log(`Cleaned up download directory: ${currentDownloadDir}`);
          }, 1000);

          // Close the proxy's WebSocket server and HTTP server
          proxyWss.close(() => console.log(`Proxy WebSocket server closed for ${currentDownloadDir}`));
          blazeProxyServer.close(() => console.log(`Proxy HTTP server closed for ${currentDownloadDir}`));
        }
      } catch (e) {
        console.error(`Error processing WebSocket message for ${currentDownloadDir}:`, e);
        conn.send(
          JSON.stringify({
            type: 'error',
            msg: 'An error occurred processing your WebSocket message.',
            timestamp: new Date(),
          })
        );
      }
    });

    conn.on('close', () => {
      console.log(`WebSocket connection closed for proxy in ${currentDownloadDir}`);
    });

    conn.on('error', (err) => {
      console.error(`WebSocket error for proxy in ${currentDownloadDir}:`, err);
    });
  });

  // --- Proxy all incoming requests for this proxy instance ---
  blazeProxy.all('*', async (req, proxyRes) => {
    let wsConnectionForLogging = null;
    // Find an active WebSocket connection for this proxy to send logs
    for (const client of proxyWss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        wsConnectionForLogging = client;
        break;
      }
    }

    try {
      // Fetch the file from the external game URL
      const file = await fetch(gameUrl + req.originalUrl);

      // Determine content type and file extension
      const contentType = file.headers.get('content-type');
      let fileExtension = '';
      if (contentType) {
        fileExtension = mime.getExtension(contentType.split(';')[0].replace('text/javascript', 'application/javascript'));
      }
      // Fallback: try to guess extension from the original URL if not found via content-type
      if (!fileExtension) {
        const extFromUrl = path.extname(req.originalUrl);
        if (extFromUrl) {
          fileExtension = extFromUrl.substring(1); // Remove the leading dot
        }
      }

      const data = Buffer.from(await file.arrayBuffer());

      // Construct the full path for the file within the current unique download directory
      let targetFilePath = path.join(currentDownloadDir, req.originalUrl);

      // Handle root path ('/') as index.html
      if (req.originalUrl === '/') {
        targetFilePath = path.join(currentDownloadDir, 'index.html');
      } else if (!path.extname(req.originalUrl) && fileExtension) {
        // If originalUrl has no extension but content-type provided one, append it
        targetFilePath = `${targetFilePath}.${fileExtension}`;
      }

      const dirPath = path.dirname(targetFilePath); // Get the directory part

      // Ensure directory exists for the file to be written
      fs.mkdir(dirPath, { recursive: true }, (e) => {
        if (e) {
          console.error(`Error creating directory ${dirPath} for ${req.originalUrl}:`, e);
          if (wsConnectionForLogging) {
            wsConnectionForLogging.send(
              JSON.stringify({
                type: 'error',
                msg: `An error occurred creating directory ${dirPath}. Check proxy console.`,
                timestamp: new Date(),
              })
            );
          }
          return proxyRes.sendStatus(404); // Return 404 to the client for this request
        }
      });

      // Log the download attempt via WebSocket
      if (wsConnectionForLogging) {
        wsConnectionForLogging.send(
          JSON.stringify({
            type: 'log',
            msg: `Downloading: ${req.originalUrl} to ${targetFilePath}`,
            timestamp: new Date(),
          })
        );
      }

      // If the file fetch was successful (HTTP status 2xx)
      if (file.status >= 200 && file.status < 300) {
        // Add to the list of paths that were intended to be downloaded
        paths.push(req.originalUrl);

        // Write the file to disk after a small delay (original code's pattern)
        setTimeout(() => {
          try {
            fs.writeFileSync(targetFilePath, data);
            if (wsConnectionForLogging) {
              wsConnectionForLogging.send(
                JSON.stringify({
                  type: 'log',
                  msg: `Successfully saved: ${targetFilePath}`,
                  timestamp: new Date(),
                })
              );
            }
          } catch (e) {
            console.error(`Error writing ${targetFilePath} to disk:`, e);
            if (wsConnectionForLogging) {
              wsConnectionForLogging.send(
                JSON.stringify({
                  type: 'error',
                  msg: `An error occurred writing ${req.originalUrl} to disk. Check proxy console.`,
                  timestamp: new Date(),
                })
              );
            }
          }
        }, 500);
      } else if (file.status === 404) {
        if (wsConnectionForLogging) {
          wsConnectionForLogging.send(
            JSON.stringify({
              type: 'error',
              msg: `Could not find ${req.originalUrl} (404 Not Found)`,
              timestamp: new Date(),
            })
          );
        }
      } else if (file.status === 403) {
        if (wsConnectionForLogging) {
          wsConnectionForLogging.send(
            JSON.stringify({
              type: 'error',
              msg: `Could not access ${req.originalUrl} (403 Forbidden)`,
              timestamp: new Date(),
            })
          );
        }
      } else {
        // Log other non-success HTTP statuses
        if (wsConnectionForLogging) {
          wsConnectionForLogging.send(
            JSON.stringify({
              type: 'error',
              msg: `An unexpected HTTP status (${file.status}) occurred for ${req.originalUrl}`,
              timestamp: new Date(),
            })
          );
        }
      }

      // Forward the response headers and data from the fetched file back to the client
      proxyRes.writeHead(file.status, { 'Content-Type': contentType ? contentType.split(';')[0] : 'application/octet-stream' });
      proxyRes.end(data);

    } catch (e) {
      console.error(`Error during proxy request for ${req.originalUrl}:`, e);
      if (wsConnectionForLogging) {
        wsConnectionForLogging.send(
          JSON.stringify({
            type: 'error',
            msg: 'An error occurred during proxying or writing. Check proxy console.',
            timestamp: new Date(),
          })
        );
      }
      return proxyRes.sendStatus(500); // Send internal server error to the client
    }
  });

  // --- Start the proxy server on a dynamic port ---
  let assignedProxyPort = currentProxyPort;
  blazeProxyServer.listen(assignedProxyPort);

  blazeProxyServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { // Check for 'EADDRINUSE' using 'code' property
      console.log(`Port ${assignedProxyPort} is in use, trying next port...`);
      currentProxyPort++; // Increment global port counter
      assignedProxyPort = currentProxyPort; // Assign new port
      blazeProxyServer.listen(assignedProxyPort); // Retry listening on the new port
    } else {
      console.error(`The blaze proxy server encountered an error for ${currentDownloadDir}:`, e);
      if (!res.headersSent) {
        res.status(500).json({ error: true, errorMsg: 'The proxy server encountered an error. Please check the logs.' });
      }
      // Ensure the server is closed if there's an unrecoverable error
      proxyWss.close();
      blazeProxyServer.close();
    }
  });

  blazeProxyServer.on('listening', () => {
    console.log(`Your Blaze proxy server for ${currentDownloadDir} is running on port ${blazeProxyServer.address().port}`);
    // Respond to the client with the assigned proxy port
    if (!res.headersSent) {
      res.json({ error: false, port: blazeProxyServer.address().port });
    }
  });

  blazeProxyServer.on('close', () => {
    console.log(`Your Blaze proxy server for ${currentDownloadDir} has stopped`);
  });
});

// --- Handle 404 for the main Express server ---
app.use((req, res) => {
  res.status(404);
  res.sendFile(path.join(url.fileURLToPath(new URL('./content/', import.meta.url)), '/404.html'));
});

// --- Start the main Express server ---
const mainBlazeServer = app.listen(MAIN_SERVER_PORT, () => {
  console.log(`Your Blaze main server is running on port ${mainBlazeServer.address().port} using node ${process.version}`);
});

// Global WebSocket server for general communication (if needed by other parts of the app)
// For download-specific logging, the WS server is now created per proxy instance.
// This `wss` is attached to the main HTTP server.
// If the client needs to connect to the main WS server, it connects to MAIN_SERVER_PORT.
// If it needs to connect to the proxy's WS, it connects to the `port` returned by the /form endpoint.
const wss = new WebSocketServer({ server: mainBlazeServer });

wss.on('connection', (conn, req) => {
  console.log('New WebSocket connection to MAIN server established.');
  // This global WebSocket can be used for other purposes, but download-specific logs
  // will now go through the WebSocket server attached to the individual proxy.
  conn.on('message', (message) => {
    console.log(`Received message on MAIN WS: ${message.toString()}`);
    // You can add logic here for general application control/messaging
  });
  conn.on('close', () => console.log('Main WS connection closed.'));
  conn.on('error', (err) => console.error('Main WS error:', err));
});
