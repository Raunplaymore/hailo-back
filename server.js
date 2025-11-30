// Swing video upload server for Raspberry Pi
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
// Default to local uploads directory; allow override for Raspberry Pi via env
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

// Ensure upload directory exists
fs.mkdirSync(uploadDir, { recursive: true });

// Configure multer storage: timestamp prefix keeps uploads unique
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({ storage });

// Upload endpoint: expects multipart/form-data with field "video"
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, message: 'No file uploaded' });
  }
  res.json({ ok: true, file: req.file.filename });
});

// List uploaded files
app.get('/api/files', (_req, res) => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
    res.json(files);
  });
});

// Serve built React app
app.use(express.static(path.join(__dirname, 'client-dist')));

// SPA fallback for all other GET routes (regex avoids Express 5 wildcard parsing issues)
app.get(/.*/, (_req, res) => {
  const indexPath = path.join(__dirname, 'client-dist', 'index.html');
  fs.access(indexPath, fs.constants.F_OK, (err) => {
    if (err) {
      return res.status(404).send('index.html not found');
    }
    res.sendFile(indexPath);
  });
});

// Global error handler to ensure JSON error responses
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, message: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Swing server listening on port ${PORT}`);
});
