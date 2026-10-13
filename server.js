const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(PUBLIC_DIR, 'data');
const PRODUTOS_FILE = path.join(DATA_DIR, 'produtos.json');
const EBOOKS_FILE = path.join(DATA_DIR, 'ebooks.json');
const ADMIN_CONFIG_FILE = path.join(DATA_DIR, 'admin-config.json');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'assets', 'images');

// Garante que as pastas necessárias existem
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Configuração padrão de credenciais se não existir
if (!fs.existsSync(ADMIN_CONFIG_FILE)) {
    fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify({
        username: 'admin',
        password: 'admin123'
    }, null, 2), 'utf8');
}

// Sessões ativas em memória (token -> { username, createdAt })
const activeSessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

const cleanOldSessions = () => {
    const now = Date.now();
    for (const [token, session] of activeSessions.entries()) {
        if (now - session.createdAt > SESSION_TTL_MS) {
            activeSessions.delete(token);
        }
    }
};

const getAuthToken = (req) => {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7).trim();
    }
    if (req.headers['x-admin-token']) {
        return req.headers['x-admin-token'];
    }
    // Suporte a cookie admin_token
    const cookieHeader = req.headers['cookie'];
    if (cookieHeader) {
        const cookies = cookieHeader.split(';').map(c => c.trim());
        for (const cookie of cookies) {
            if (cookie.startsWith('admin_token=')) {
                return cookie.substring('admin_token='.length);
            }
        }
    }
    return null;
};

const isAuthenticated = (req) => {
    cleanOldSessions();
    const token = getAuthToken(req);
    if (!token) return false;
    const session = activeSessions.get(token);
    if (!session) return false;
    return session;
};

const getAdminCredentials = () => {
    try {
        if (fs.existsSync(ADMIN_CONFIG_FILE)) {
            const data = fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Erro ao ler admin-config.json:', e);
    }
    return { username: 'admin', password: 'admin123' };
};

const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'text/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.json': 'application/json; charset=UTF-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
};

const parseJsonBody = (req, maxBytes = 50 * 1024 * 1024) => {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('Corpo da requisição excede o limite máximo permitido'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const bodyStr = Buffer.concat(chunks).toString('utf8');
                if (!bodyStr.trim()) {
                    return resolve({});
                }
                const parsed = JSON.parse(bodyStr);
                resolve(parsed);
            } catch (err) {
                reject(new Error('JSON inválido'));
            }
        });
        req.on('error', err => reject(err));
    });
};

const sendJson = (res, statusCode, data) => {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // ==========================================
    // API ROUTES
    // ==========================================

    // 1. Login
    if (pathname === '/api/login' && method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { username, password } = body;
            const currentCreds = getAdminCredentials();

            if (username === currentCreds.username && password === currentCreds.password) {
                const token = crypto.randomBytes(32).toString('hex');
                activeSessions.set(token, {
                    username,
                    createdAt: Date.now()
                });

                return sendJson(res, 200, {
                    success: true,
                    token,
                    username,
                    message: 'Login realizado com sucesso!'
                });
            } else {
                return sendJson(res, 401, {
                    success: false,
                    error: 'Usuário ou senha incorretos.'
                });
            }
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // 2. Auth Check
    if (pathname === '/api/auth-check' && method === 'GET') {
        const session = isAuthenticated(req);
        if (session) {
            return sendJson(res, 200, {
                authenticated: true,
                username: session.username
            });
        } else {
            return sendJson(res, 401, {
                authenticated: false,
                error: 'Não autenticado.'
            });
        }
    }

    // 3. Logout
    if (pathname === '/api/logout' && method === 'POST') {
        const token = getAuthToken(req);
        if (token) {
            activeSessions.delete(token);
        }
        return sendJson(res, 200, { success: true, message: 'Logout realizado.' });
    }

    // 4. Alterar Senha
    if (pathname === '/api/change-password' && method === 'POST') {
        const session = isAuthenticated(req);
        if (!session) {
            return sendJson(res, 401, { success: false, error: 'Acesso não autorizado.' });
        }

        try {
            const body = await parseJsonBody(req);
            const { currentPassword, newUsername, newPassword } = body;
            const currentCreds = getAdminCredentials();

            if (currentPassword !== currentCreds.password) {
                return sendJson(res, 400, { success: false, error: 'Senha atual incorreta.' });
            }

            if (!newPassword || newPassword.trim().length < 4) {
                return sendJson(res, 400, { success: false, error: 'A nova senha deve ter no mínimo 4 caracteres.' });
            }

            const updatedCreds = {
                username: (newUsername && newUsername.trim()) ? newUsername.trim() : currentCreds.username,
                password: newPassword.trim()
            };

            fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(updatedCreds, null, 2), 'utf8');

            return sendJson(res, 200, {
                success: true,
                username: updatedCreds.username,
                message: 'Credenciais atualizadas com sucesso!'
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // 5. Obter Produtos (Público)
    if (pathname === '/api/produtos' && method === 'GET') {
        try {
            if (fs.existsSync(PRODUTOS_FILE)) {
                const data = fs.readFileSync(PRODUTOS_FILE, 'utf8');
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                });
                res.end(data);
                return;
            } else {
                return sendJson(res, 200, []);
            }
        } catch (err) {
            return sendJson(res, 500, { success: false, error: 'Erro ao ler arquivo de produtos.' });
        }
    }

    // 6. Atualizar / Salvar Produtos (Requer Autenticação)
    if (pathname === '/api/produtos' && method === 'POST') {
        const session = isAuthenticated(req);
        if (!session) {
            return sendJson(res, 401, { success: false, error: 'Acesso não autorizado.' });
        }

        try {
            const body = await parseJsonBody(req);
            if (!Array.isArray(body)) {
                return sendJson(res, 400, { success: false, error: 'Formato inválido. Esperado um array de produtos.' });
            }

            fs.writeFileSync(PRODUTOS_FILE, JSON.stringify(body, null, 2), 'utf8');

            console.log(`[ADMIN] Produtos atualizados com sucesso por ${session.username} (${body.length} itens)`);

            return sendJson(res, 200, {
                success: true,
                count: body.length,
                message: 'Produtos salvos com sucesso!'
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // 7. Obter E-books (Público)
    if (pathname === '/api/ebooks' && method === 'GET') {
        try {
            if (fs.existsSync(EBOOKS_FILE)) {
                const data = fs.readFileSync(EBOOKS_FILE, 'utf8');
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                });
                res.end(data);
                return;
            } else {
                return sendJson(res, 200, []);
            }
        } catch (err) {
            return sendJson(res, 500, { success: false, error: 'Erro ao ler arquivo de ebooks.' });
        }
    }

    // 8. Atualizar / Salvar E-books (Requer Autenticação)
    if (pathname === '/api/ebooks' && method === 'POST') {
        const session = isAuthenticated(req);
        if (!session) {
            return sendJson(res, 401, { success: false, error: 'Acesso não autorizado.' });
        }

        try {
            const body = await parseJsonBody(req);
            if (!Array.isArray(body)) {
                return sendJson(res, 400, { success: false, error: 'Formato inválido. Esperado um array de ebooks.' });
            }

            fs.writeFileSync(EBOOKS_FILE, JSON.stringify(body, null, 2), 'utf8');

            console.log(`[ADMIN] E-books atualizados com sucesso por ${session.username} (${body.length} itens)`);

            return sendJson(res, 200, {
                success: true,
                count: body.length,
                message: 'E-books salvos com sucesso!'
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // 9. Upload de Imagem (Requer Autenticação)
    if (pathname === '/api/upload' && method === 'POST') {
        const session = isAuthenticated(req);
        if (!session) {
            return sendJson(res, 401, { success: false, error: 'Acesso não autorizado.' });
        }

        try {
            const body = await parseJsonBody(req);
            const { filename, base64 } = body;

            if (!filename || !base64) {
                return sendJson(res, 400, { success: false, error: 'Parâmetros "filename" e "base64" são obrigatórios.' });
            }

            // Sanitiza extensão
            const rawExt = path.extname(filename).toLowerCase() || '.jpg';
            const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
            const ext = allowedExts.includes(rawExt) ? rawExt : '.jpg';

            // Sanitiza nome base
            const rawBase = path.basename(filename, rawExt)
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9_-]/g, '-')
                .replace(/-+/g, '-')
                .slice(0, 50);

            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e4);
            const safeFileName = `${rawBase || 'foto'}-${uniqueSuffix}${ext}`;
            const targetPath = path.join(UPLOADS_DIR, safeFileName);

            // Extrai dados binários do base64
            const cleanBase64 = base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
            const buffer = Buffer.from(cleanBase64, 'base64');

            fs.writeFileSync(targetPath, buffer);

            const publicUrl = `assets/images/${safeFileName}`;
            console.log(`[ADMIN] Nova foto enviada: ${publicUrl}`);

            return sendJson(res, 200, {
                success: true,
                url: publicUrl,
                filename: safeFileName
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // ==========================================
    // STATIC FILE SERVING
    // ==========================================
    let reqUrl = pathname;
    if (reqUrl === '/' || reqUrl === '') {
        reqUrl = '/index.html';
    }

    let safePath = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(PUBLIC_DIR, safePath);

    const serveFile = (targetPath) => {
        const ext = path.extname(targetPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        const stream = fs.createReadStream(targetPath);
        stream.pipe(res);
    };

    fs.stat(filePath, (err, stats) => {
        if (!err && stats.isFile()) {
            return serveFile(filePath);
        }

        // Suporte a URLs amigáveis (ex: /admin -> /admin.html)
        const htmlPath = filePath + '.html';
        fs.stat(htmlPath, (htmlErr, htmlStats) => {
            if (!htmlErr && htmlStats.isFile()) {
                return serveFile(htmlPath);
            }

            const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
            fs.readFile(fallbackPath, (fallbackErr, data) => {
                if (fallbackErr) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
                    res.end('404 Not Found');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
                res.end(data);
            });
        });
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor local iniciado com sucesso!`);
    console.log(`📡 URL Local:      http://localhost:${PORT}`);
    console.log(`🔒 Painel Admin:   http://localhost:${PORT}/admin`);
    console.log(`📂 Diretório:      ${PUBLIC_DIR}`);
    console.log(`Pressione Ctrl+C para encerrar o servidor.\n`);
});
