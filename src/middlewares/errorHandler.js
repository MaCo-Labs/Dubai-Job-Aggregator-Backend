const logger = require('../config/logger');

const errorHandler = (err, req, res, next) => {
    logger.error(err.stack || err.message);

    if (err.name === 'ValidationError') {
        return res.status(400).json({
            error: 'Validation Error',
            details: Object.values(err.errors).map((e) => e.message),
        });
    }

    if (err.name === 'CastError') {
        return res.status(400).json({ error: 'Invalid ID format' });
    }

    if (err.code === 11000) {
        return res.status(409).json({ error: 'Duplicate entry' });
    }

    if (err.message && err.message.includes('Only .xlsx')) {
        return res.status(400).json({ error: err.message });
    }

    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error',
    });
};

module.exports = errorHandler;
