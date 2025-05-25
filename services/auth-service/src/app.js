// auth-service/src/app.js
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const logger = require('./logger'); // Import logger đã tích hợp Winston

const app = express();
const MONGODB_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3001; // Cổng mặc định cho Auth Service

app.use(cors());
app.use(express.json()); // Middleware để phân tích JSON body

// Kết nối MongoDB (Replica Set)
mongoose.connect(MONGODB_URI)
    .then(() => logger.info('[Auth Service] Connected to MongoDB Replica Set'))
    .catch(err => logger.error('[Auth Service] Could not connect to MongoDB:', err));

// Định nghĩa Schema và Model cho User
const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const User = mongoose.model('User', UserSchema);

// Middleware xác thực JWT
const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (authHeader) {
        const token = authHeader.split(' ')[1]; // Lấy token từ header "Bearer TOKEN"

        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) {
                logger.warn('Auth Service: JWT verification failed.', err);
                return res.status(403).json({ message: 'Invalid or expired token.' });
            }
            req.user = user; // Gán payload của token vào req.user
            next();
        });
    } else {
        logger.warn('Auth Service: Authorization token required.');
        res.status(401).json({ message: 'Authorization token required.' });
    }
};

// Endpoint đăng ký người dùng
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    logger.info(`[Auth Service] Register attempt for username: ${username}`);
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        logger.info(`[Auth Service] User registered successfully: ${username}`);
        res.status(201).json({ message: 'User registered successfully!' });
    } catch (error) {
        if (error.code === 11000) { // Lỗi trùng lặp username (E11000 duplicate key error)
            logger.error(`[Auth Service] Registration failed: Username already exists - ${username}`);
            return res.status(409).json({ message: 'Username already exists.' });
        }
        logger.error('[Auth Service] Registration error:', error);
        res.status(500).json({ message: 'Registration failed.' });
    }
});

// Endpoint đăng nhập người dùng
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    logger.info(`[Auth Service] Login attempt for username: ${username}`);
    try {
        const user = await User.findOne({ username });
        if (!user) {
            logger.warn(`[Auth Service] Login failed: User not found - ${username}`);
            return res.status(400).json({ message: 'Invalid credentials.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            logger.warn(`[Auth Service] Login failed: Incorrect password for user - ${username}`);
            return res.status(400).json({ message: 'Invalid credentials.' });
        }

        // Tạo JWT
        const token = jwt.sign(
            { userId: user._id, username: user.username },
            JWT_SECRET,
            { expiresIn: '1h' } // Token hết hạn sau 1 giờ
        );
        logger.info(`[Auth Service] User logged in successfully: ${username}`);
        res.status(200).json({ message: 'Login successful!', token });
    } catch (error) {
        logger.error('[Auth Service] Login error:', error);
        res.status(500).json({ message: 'Login failed.' });
    }
});

// Endpoint để lấy thông tin profile người dùng (yêu cầu JWT)
app.get('/profile', authenticateJWT, (req, res) => {
    logger.info(`[Auth Service] Profile requested by user: ${req.user.username}`);
    res.status(200).json({
        userId: req.user.userId,
        username: req.user.username,
        message: 'Profile data retrieved successfully.'
    });
});

// Endpoint để tìm kiếm người dùng theo username (yêu cầu JWT)
app.get('/users/search', authenticateJWT, async (req, res) => {
    const { username } = req.query;
    if (!username || username.trim() === '') {
        logger.warn('Auth Service: Search username parameter is empty.');
        return res.status(400).json({ message: 'Username search parameter is required.' });
    }

    try {
        // Tìm kiếm người dùng có username chứa chuỗi tìm kiếm (case-insensitive)
        const users = await User.find({
            username: { $regex: username, $options: 'i' },
            _id: { $ne: req.user.userId } // Không trả về chính người dùng đang tìm kiếm
        }).select('username _id'); // Chỉ trả về username và _id

        logger.info(`Auth Service: Found ${users.length} users for search term "${username}" by user ${req.user.username}`);
        res.status(200).json(users);
    } catch (error) {
        logger.error('Auth Service: Error searching for users:', error);
        res.status(500).json({ message: 'Error searching for users.' });
    }
});

// Xử lý lỗi 404 (Not Found)
app.use((req, res, next) => {
    logger.warn(`Auth Service: 404 Not Found - ${req.method} ${req.originalUrl}`);
    res.status(404).send('Auth Service: Endpoint not found');
});

// Xử lý lỗi chung
app.use((err, req, res, next) => {
    logger.error('Auth Service: An unhandled error occurred:', err.stack);
    res.status(500).send('Auth Service: Something broke!');
});

app.listen(PORT, () => {
    logger.info(`Auth Service running on port ${PORT}`);
});