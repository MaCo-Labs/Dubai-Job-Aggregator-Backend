const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jobRoutes = require('./routes/jobRoutes');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../../frontend')));

// API routes
app.use('/api', jobRoutes);

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

// Error handler
app.use(errorHandler);

module.exports = app;
