const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

// Servir les fichiers statiques du dossier courant (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '.')));

const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_app_rencontre_2026';

// Base de données temporaire en mémoire
const db = {
    users: [],
    photos: [],
    interactions: [],
    matches: [],
    messages: [],
    reports: []
};

// Route principale pour servir la page HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Middleware d'authentification JWT
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

// --- ROUTES AUTHENTIFICATION ---

// Inscription
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, full_name, age, gender, city, bio } = req.body;
        
        if (!email || !password || !full_name) {
            return res.status(400).json({ error: "Veuillez remplir tous les champs obligatoires" });
        }

        const existingUser = db.users.find(u => u.email === email);
        if (existingUser) {
            return res.status(400).json({ error: "Cet email est déjà utilisé" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: String(db.users.length + 1),
            email,
            password: hashedPassword,
            role: db.users.length === 0 ? 'admin' : 'user', // Le 1er inscrit devient Admin
            full_name,
            age: parseInt(age) || 18,
            gender: gender || 'Non spécifié',
            city: city || 'Non spécifiée',
            bio: bio || ''
        };
        
        db.users.push(newUser);

        const token = jwt.sign({ id: newUser.id, role: newUser.role }, JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ token, user: { id: newUser.id, full_name: newUser.full_name, email: newUser.email, role: newUser.role } });
    } catch (err) {
        res.status(500).json({ error: "Erreur serveur lors de l'inscription" });
    }
});

// Connexion
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = db.users.find(u => u.email === email);
        if (!user) return res.status(400).json({ error: "Identifiants incorrects" });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: "Identifiants incorrects" });

        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: "Erreur serveur lors de la connexion" });
    }
});

// --- ROUTES UTILISATEURS & RENCONTRES ---

// Récupérer les profils pour le Discovery Swipe
app.get('/api/users/discover', authenticateToken, (req, res) => {
    const currentUserId = req.user.id;
    const interactedUserIds = db.interactions
        .filter(i => i.from_user_id === currentUserId)
        .map(i => i.to_user_id);

    const candidates = db.users.filter(u => u.id !== currentUserId && !interactedUserIds.includes(u.id));
    res.json(candidates);
});

// Action de Swipe (Like / Dislike)
app.post('/api/interactions/swipe', authenticateToken, (req, res) => {
    const { target_user_id, action } = req.body;
    const from_user_id = req.user.id;

    db.interactions.push({ from_user_id, to_user_id: target_user_id, action });

    let isMatch = false;
    if (action === 'like') {
        const reciprocal = db.interactions.find(i => i.from_user_id === target_user_id && i.to_user_id === from_user_id && i.action === 'like');
        if (reciprocal) {
            isMatch = true;
            const matchObj = { id: String(db.matches.length + 1), user1_id: from_user_id, user2_id: target_user_id };
            db.matches.push(matchObj);
            
            // Notification temps réel aux deux utilisateurs via WebSockets
            io.emit(`match_${from_user_id}`, { matchWith: target_user_id });
            io.emit(`match_${target_user_id}`, { matchWith: from_user_id });
        }
    }

    res.json({ status: 'ok', isMatch });
});

// Récupérer la liste des matchs
app.get('/api/matches', authenticateToken, (req, res) => {
    const currentUserId = req.user.id;
    const userMatches = db.matches.filter(m => m.user1_id === currentUserId || m.user2_id === currentUserId);
    
    const matchedUsers = userMatches.map(m => {
        const otherId = m.user1_id === currentUserId ? m.user2_id : m.user1_id;
        const otherUser = db.users.find(u => u.id === otherId);
        return { match_id: m.id, partner: { id: otherUser.id, full_name: otherUser.full_name, city: otherUser.city } };
    });

    res.json(matchedUsers);
});

// --- WEBSOCKETS (MESSAGERIE TEMPS RÉEL) ---
io.on('connection', (socket) => {
    socket.on('join_chat', (data) => {
        socket.join(data.match_id);
    });

    socket.on('send_message', (data) => {
        const msg = {
            id: String(db.messages.length + 1),
            match_id: data.match_id,
            sender_id: data.sender_id,
            content: data.content,
            timestamp: new Date().toISOString()
        };
        db.messages.push(msg);
        io.to(data.match_id).emit('receive_message', msg);
    });
});

// Démarrage du serveur avec port dynamique pour Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));
