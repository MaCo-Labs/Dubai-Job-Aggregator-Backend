require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/database');
const logger = require('./config/logger');

const PORT = process.env.PORT || 3000;

const start = async () => {
    await connectDB();

    app.listen(PORT, () => {
        logger.info(`🚀 Job Aggregator server running at http://localhost:${PORT}`);
        logger.info(`📊 Dashboard: http://localhost:${PORT}`);
        logger.info(`📡 API: http://localhost:${PORT}/api`);
    });
};

start().catch((err) => {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
});
