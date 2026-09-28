const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

// Servir les fichiers statiques (html, css, photos)
app.use(express.static('.'));

const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_app_rencontre_2026';

// --- BASE DE DONNÉES EN MÉMOIRE ---
const db = {
    users: [],
    photos: [],
    interactions: [],
    matches: [],
    messages: [],
    reports: []
};

// --- MIDDLEWARES ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Accès refusé" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Token invalide" });
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Accès administrateur requis" });
    next();
};

// --- ROUTES AUTHENTIFICATION ---
app.post('/api/auth/register', async (req, res) => {
    const { email, password, full_name, age, gender, city, interests, bio } = req.body;
    const existingUser = db.users.find(u => u.email === email);
    if (existingUser) return res.status(400).json({ error: "Cet email est déjà utilisé" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: String(db.users.length + 1),
        email,
        password: hashedPassword,
        role: db.users.length === 0 ? 'admin' : 'user',
        full_name,
        age: parseInt(age),
        gender,
        city,
        bio: bio || '',
        interests: interests || []
    };
    db.users.push(newUser);
    
    const token = jwt.sign({ id: newUser.id, role: newUser.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: newUser.id, full_name: newUser.full_name, email: newUser.email, role: newUser.role } });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(400).json({ error: "Identifiants incorrects" });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ error: "Identifiants incorrects" });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, full_name: user.full_name, role: user.role } });
});

// --- ROUTE RECHERCHE & FILTRES ---
app.get('/api/users/search', authenticateToken, (req, res) => {
    const { minAge, maxAge, city, gender } = req.query;
    
    const interactedIds = db.interactions
        .filter(i => i.sender_id === req.user.id)
        .map(i => i.receiver_id);
    
    const blockedIds = db.reports
        .filter(r => r.reporter_id === req.user.id && r.type === 'block')
        .map(r => r.reported_id);

    const filtered = db.users.filter(u => {
        if (u.id === req.user.id) return false;
        if (interactedIds.includes(u.id) || blockedIds.includes(u.id)) return false;
        if (minAge && u.age < parseInt(minAge)) return false;
        if (maxAge && u.age > parseInt(maxAge)) return false;
        if (city && u.city.toLowerCase() !== city.toLowerCase()) return false;
        if (gender && u.gender !== gender) return false;
        return true;
    });

    res.json(filtered.map(({ password, ...u }) => u));
});

// --- LIKES, DISLIKES & MATCHS ---
app.post('/api/interactions', authenticateToken, (req, res) => {
    const { receiver_id, type } = req.body;
    const sender_id = req.user.id;

    db.interactions.push({ sender_id, receiver_id, type });

    let isMatch = false;
    if (type === 'like') {
        const reciprocal = db.interactions.find(i => i.sender_id === receiver_id && i.receiver_id === sender_id && i.type === 'like');
        if (reciprocal) {
            isMatch = true;
            db.matches.push({ id: String(db.matches.length + 1), user1_id: sender_id, user2_id: receiver_id });
            io.to(receiver_id).emit('notification', { type: 'match', message: "Nouveau Match !" });
        }
    }

    res.json({ success: true, match: isMatch });
});

// --- SIGNALEMENT ET BLOCAGE ---
app.post('/api/security/action', authenticateToken, (req, res) => {
    const { target_id, type, reason } = req.body;
    db.reports.push({ id: String(db.reports.length + 1), reporter_id: req.user.id, reported_id: target_id, type, reason });
    res.json({ message: `Action '${type}' enregistrée avec succès.` });
});

// --- ESPACE ADMINISTRATEUR ---
app.get('/api/admin/metrics', authenticateToken, requireAdmin, (req, res) => {
    res.json({
        total_users: db.users.length,
        total_matches: db.matches.length,
        total_reports: db.reports.length,
        reports_list: db.reports
    });
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, (req, res) => {
    const userId = req.params.id;
    db.users = db.users.filter(u => u.id !== userId);
    res.json({ message: "Utilisateur supprimé par l'administrateur." });
});

// --- WEBSOCKETS (MESSAGERIE TEMPS RÉEL) ---
io.on('connection', (socket) => {
    socket.on('join_room', (userId) => {
        socket.join(userId);
    });

    socket.on('send_message', (data) => {
        const { sender_id, receiver_id, content } = data;
        const message = { id: String(db.messages.length + 1), sender_id, receiver_id, content, timestamp: new Date() };
        db.messages.push(message);

        io.to(receiver_id).emit('receive_message', message);
        io.to(sender_id).emit('message_sent', message);
    });
});

// Port dynamique pour la production (Render) ou 3000 en local
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));