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

// API routes only
app.use('/api', jobRoutes);

// Health check (optional)
app.get('/', (req, res) => {
    res.json({ status: 'Job Aggregator API running' });
});

// Error handler
app.use(errorHandler);

module.exports = app;
