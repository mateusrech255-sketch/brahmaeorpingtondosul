const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(PUBLIC_DIR, 'data');
const PRODUTOS_FILE = path.join(DATA_DIR, 'produtos.json');
const EBOOKS_FILE = path.join(DATA_DIR, 'ebooks.json');
const PEDIDOS_FILE = path.join(DATA_DIR, 'pedidos.json');
const CLIENTES_FILE = path.join(DATA_DIR, 'clientes.json');
const ADMIN_CONFIG_FILE = path.join(DATA_DIR, 'admin-config.json');
const INFINITEPAY_CONFIG_FILE = path.join(DATA_DIR, 'infinitepay-config.json');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'assets', 'images');

const DEFAULT_INFINITEPAY_CONFIG = {
    enabled: true,
    handle: 'sandro-cavalli',
    apiKey: 'inchk_jOkw1-v4xAqj0kkbPXhWs0BwIJ503mT5SwD9q2-6AuI',
    checkoutEndpoint: 'https://api.checkout.infinitepay.io/links',
    fallbackEndpoint: 'https://api.infinitepay.io/invoices/public/checkout/links',
    paymentCheckEndpoint: 'https://api.checkout.infinitepay.io/payment_check',
    fallbackPaymentCheckEndpoint: 'https://api.infinitepay.io/invoices/public/checkout/payment_check',
    docsUrl: 'https://www.infinitepay.io/checkout-documentacao',
    portalUrl: 'https://www.infinitepay.io/checkout'
};

// Garante que as pastas necessárias existem
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Inicializa arquivos se não existirem
if (!fs.existsSync(PEDIDOS_FILE)) {
    fs.writeFileSync(PEDIDOS_FILE, '[]', 'utf8');
}
if (!fs.existsSync(CLIENTES_FILE)) {
    fs.writeFileSync(CLIENTES_FILE, '[]', 'utf8');
}
if (!fs.existsSync(INFINITEPAY_CONFIG_FILE)) {
    fs.writeFileSync(INFINITEPAY_CONFIG_FILE, JSON.stringify(DEFAULT_INFINITEPAY_CONFIG, null, 2), 'utf8');
}

const getInfinitePayConfig = () => {
    try {
        if (fs.existsSync(INFINITEPAY_CONFIG_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(INFINITEPAY_CONFIG_FILE, 'utf8'));
            return { ...DEFAULT_INFINITEPAY_CONFIG, ...parsed };
        }
    } catch (e) {
        console.error('Erro ao ler infinitepay-config.json:', e);
    }
    return { ...DEFAULT_INFINITEPAY_CONFIG };
};

const httpsPostJson = (urlStr, payload, extraHeaders = {}) => {
    return new Promise((resolve, reject) => {
        const parsed = new URL(urlStr);
        const bodyData = JSON.stringify(payload);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(bodyData),
                ...extraHeaders
            },
            timeout: 15000
        };
        const reqHttps = https.request(options, (resHttps) => {
            const chunks = [];
            resHttps.on('data', chunk => chunks.push(chunk));
            resHttps.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(raw); } catch (e) {}
                resolve({
                    status: resHttps.statusCode,
                    ok: resHttps.statusCode >= 200 && resHttps.statusCode < 300,
                    data: json,
                    raw
                });
            });
        });
        reqHttps.on('error', err => reject(err));
        reqHttps.on('timeout', () => {
            reqHttps.destroy();
            reject(new Error('Tempo limite excedido ao comunicar com a API InfinitePay.'));
        });
        reqHttps.write(bodyData);
        reqHttps.end();
    });
};

const buildInfinitePayCheckoutPayload = (body, origin, cfg) => {
    const handle = String(body.handle || cfg.handle || DEFAULT_INFINITEPAY_CONFIG.handle).replace(/^\$/, '').trim();
    const orderNsu = String(body.order_nsu || body.orderId || ('BOS-' + Math.floor(1000 + Math.random() * 9000))).replace(/^#/, '').trim();

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items = rawItems.map(it => {
        const qty = Math.max(1, Math.round(Number(it.quantity || it.quantidade || 1)));
        const priceCents = it.price_cents
            ? Math.round(Number(it.price_cents))
            : (Number(it.price) >= 1000 && !it.isUnitReais
                ? Math.round(Number(it.price))
                : Math.round(Number(it.precoUnitario || it.price || 0) * 100));
        const desc = String(it.description || (it.opcaoLabel ? `${it.nome || it.name} (${it.opcaoLabel})` : (it.nome || it.name || 'Produto'))).trim();
        return {
            quantity: qty,
            price: priceCents,
            description: desc
        };
    }).filter(it => it.price > 0);

    const freteValor = Number(body.freteValor ?? body.frete?.valor ?? 0);
    const hasFreteItem = items.some(i => i.description.toLowerCase().includes('frete'));
    if (freteValor > 0 && !hasFreteItem) {
        const freteTipo = body.frete?.tipo || 'SEDEX';
        const freteDestino = body.frete?.cidade ? ` (${body.frete.cidade}${body.frete.uf ? ' - ' + body.frete.uf : ''})` : '';
        items.push({
            quantity: 1,
            price: Math.round(freteValor * 100),
            description: `Frete ${freteTipo} Correios${freteDestino}`
        });
    }

    const isLocalOrigin = !origin || origin.includes('localhost') || origin.includes('127.0.0.1');
    const safeOrigin = isLocalOrigin ? 'https://brahmaeorpingtondosul.pages.dev' : origin;

    const redirectUrl = body.redirect_url || `${origin || safeOrigin}/?infinitepay_return=1&order_nsu=${encodeURIComponent(orderNsu)}`;
    const webhookUrl = body.webhook_url || `${safeOrigin}/api/infinitepay/webhook`;

    const payload = {
        handle,
        order_nsu: orderNsu,
        redirect_url: redirectUrl,
        webhook_url: webhookUrl,
        items
    };

    const cli = body.customer || body.cliente;
    if (cli && (cli.nome || cli.name)) {
        const rawPhone = String(cli.phone_number || cli.whatsapp || '').replace(/\D/g, '');
        const formattedPhone = rawPhone
            ? (rawPhone.startsWith('55') ? `+${rawPhone}` : `+55${rawPhone}`)
            : undefined;
        const customerObj = {
            name: String(cli.name || cli.nome).trim()
        };
        if (cli.email && String(cli.email).includes('@')) {
            customerObj.email = String(cli.email).trim();
        }
        if (formattedPhone && formattedPhone.length >= 12) {
            customerObj.phone_number = formattedPhone;
        }
        payload.customer = customerObj;
    }

    const end = body.address || body.cliente?.endereco;
    if (end) {
        const cleanCep = String(end.cep || '').replace(/\D/g, '');
        const street = String(end.street || end.logradouro || '').trim();
        if (cleanCep.length === 8 && street) {
            payload.address = {
                cep: cleanCep,
                street,
                neighborhood: String(end.neighborhood || end.bairro || 'Centro').trim() || 'Centro',
                number: String(end.number || end.numero || 'S/N').trim() || 'S/N'
            };
            if (end.complement || end.complemento) {
                payload.address.complement = String(end.complement || end.complemento).trim();
            }
        }
    }

    return payload;
};

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

// Sessões ativas de clientes (token -> { clienteId, email, nome, createdAt })
const activeClientSessions = new Map();

// ==========================================
// LIVE RELOAD (SSE - Tempo Real)
// ==========================================
const liveReloadClients = new Set();
let reloadDebounceTimer = null;

const triggerLiveReload = () => {
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = setTimeout(() => {
        for (const client of liveReloadClients) {
            try {
                client.write('data: reload\n\n');
            } catch (e) {
                liveReloadClients.delete(client);
            }
        }
    }, 150);
};

try {
    fs.watch(PUBLIC_DIR, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const normalized = filename.replace(/\\/g, '/');
        // Ignora pastas internas e arquivos de dados
        if (
            normalized.includes('.git') ||
            normalized.includes('node_modules') ||
            normalized.startsWith('data/') ||
            normalized.endsWith('.json') ||
            normalized.startsWith('.')
        ) {
            return;
        }
        triggerLiveReload();
    });
} catch (e) {
    console.warn('[LiveReload] Watcher recursivo não disponível:', e.message);
}

const getClientAuthToken = (req) => {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7).trim();
    }
    if (req.headers['x-client-token']) {
        return req.headers['x-client-token'];
    }
    return null;
};

const isClientAuthenticated = (req) => {
    const token = getClientAuthToken(req);
    if (!token) return null;
    const session = activeClientSessions.get(token);
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        activeClientSessions.delete(token);
        return null;
    }
    return session;
};

const hashPassword = (password) => {
    return crypto.createHash('sha256').update(String(password)).digest('hex');
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
    // API ROUTES & LIVE RELOAD
    // ==========================================

    // Endpoint Live Reload (SSE para recarregar navegador em tempo real)
    if (pathname === '/__livereload') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        res.write('retry: 1500\n\n');
        liveReloadClients.add(res);
        req.on('close', () => {
            liveReloadClients.delete(res);
        });
        return;
    }

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
            fs.writeFileSync(path.join(DATA_DIR, 'products.json'), JSON.stringify(body, null, 2), 'utf8');

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
    // ROTAS DE CLIENTES (CADASTRO E LOGIN)
    // ==========================================

    // 10. Cadastro de Cliente
    if (pathname === '/api/clientes/cadastro' && method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { nome, email, whatsapp, senha, endereco } = body;

            if (!nome || !email || !whatsapp || !senha) {
                return sendJson(res, 400, { success: false, error: 'Todos os campos obrigatórios devem ser preenchidos.' });
            }

            const cleanEmail = email.trim().toLowerCase();
            if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) {
                return sendJson(res, 400, { success: false, error: 'E-mail informado é inválido.' });
            }

            if (String(senha).length < 6) {
                return sendJson(res, 400, { success: false, error: 'A senha deve conter pelo menos 6 caracteres.' });
            }

            let clientes = [];
            if (fs.existsSync(CLIENTES_FILE)) {
                try {
                    clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE, 'utf8'));
                } catch (e) { clientes = []; }
            }

            const existing = clientes.find(c => c.email && c.email.toLowerCase() === cleanEmail);
            if (existing) {
                return sendJson(res, 400, { success: false, error: 'Já existe uma conta cadastrada com este e-mail. Faça login.' });
            }

            const novoCliente = {
                id: 'cli-' + Date.now() + '-' + Math.round(Math.random() * 1000),
                nome: nome.trim(),
                email: cleanEmail,
                whatsapp: whatsapp.trim(),
                senhaHash: hashPassword(senha),
                endereco: endereco || {},
                criadoEm: new Date().toISOString()
            };

            clientes.push(novoCliente);
            fs.writeFileSync(CLIENTES_FILE, JSON.stringify(clientes, null, 2), 'utf8');

            const token = crypto.randomBytes(32).toString('hex');
            activeClientSessions.set(token, {
                clienteId: novoCliente.id,
                email: novoCliente.email,
                nome: novoCliente.nome,
                createdAt: Date.now()
            });

            console.log(`[CLIENTE] Novo cadastro realizado: ${novoCliente.nome} (${novoCliente.email})`);

            const { senhaHash, ...clientePublico } = novoCliente;
            return sendJson(res, 201, {
                success: true,
                token,
                cliente: clientePublico,
                message: 'Conta criada com sucesso!'
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // 11. Login de Cliente
    if (pathname === '/api/clientes/login' && method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { email, senha } = body;

            if (!email || !senha) {
                return sendJson(res, 400, { success: false, error: 'Informe e-mail e senha.' });
            }

            const cleanEmail = email.trim().toLowerCase();
            const senhaHash = hashPassword(senha);

            let clientes = [];
            if (fs.existsSync(CLIENTES_FILE)) {
                try {
                    clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE, 'utf8'));
                } catch (e) { clientes = []; }
            }

            const cliente = clientes.find(c => c.email && c.email.toLowerCase() === cleanEmail && c.senhaHash === senhaHash);
            if (!cliente) {
                return sendJson(res, 401, { success: false, error: 'E-mail ou senha incorretos.' });
            }

            const token = crypto.randomBytes(32).toString('hex');
            activeClientSessions.set(token, {
                clienteId: cliente.id,
                email: cliente.email,
                nome: cliente.nome,
                createdAt: Date.now()
            });

            console.log(`[CLIENTE] Login realizado: ${cliente.nome} (${cliente.email})`);

            const { senhaHash: _, ...clientePublico } = cliente;
            return sendJson(res, 200, {
                success: true,
                token,
                cliente: clientePublico,
                message: 'Login realizado com sucesso!'
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // 12. Obter Dados do Cliente Atual
    if (pathname === '/api/clientes/me' && method === 'GET') {
        const session = isClientAuthenticated(req);
        if (!session) {
            return sendJson(res, 401, { success: false, error: 'Sessão expirada ou não autenticada.' });
        }

        let clientes = [];
        if (fs.existsSync(CLIENTES_FILE)) {
            try { clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE, 'utf8')); } catch (e) { clientes = []; }
        }

        const cliente = clientes.find(c => c.id === session.clienteId);
        if (!cliente) {
            return sendJson(res, 404, { success: false, error: 'Cliente não encontrado.' });
        }

        const { senhaHash: _, ...clientePublico } = cliente;
        return sendJson(res, 200, { success: true, cliente: clientePublico });
    }

    // 13. Atualizar Endereço / Dados do Cliente
    if (pathname === '/api/clientes/me' && method === 'PUT') {
        const session = isClientAuthenticated(req);
        if (!session) {
            return sendJson(res, 401, { success: false, error: 'Não autenticado.' });
        }

        try {
            const body = await parseJsonBody(req);
            let clientes = [];
            if (fs.existsSync(CLIENTES_FILE)) {
                try { clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE, 'utf8')); } catch (e) { clientes = []; }
            }

            const idx = clientes.findIndex(c => c.id === session.clienteId);
            if (idx === -1) {
                return sendJson(res, 404, { success: false, error: 'Cliente não encontrado.' });
            }

            if (body.nome) clientes[idx].nome = body.nome.trim();
            if (body.whatsapp) clientes[idx].whatsapp = body.whatsapp.trim();
            if (body.endereco) {
                clientes[idx].endereco = {
                    ...clientes[idx].endereco,
                    ...body.endereco
                };
            }
            if (body.senha && String(body.senha).length >= 6) {
                clientes[idx].senhaHash = hashPassword(body.senha);
            }

            fs.writeFileSync(CLIENTES_FILE, JSON.stringify(clientes, null, 2), 'utf8');

            const { senhaHash: _, ...clientePublico } = clientes[idx];
            return sendJson(res, 200, { success: true, cliente: clientePublico, message: 'Dados atualizados com sucesso!' });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // ==========================================
    // ROTAS DE PEDIDOS
    // ==========================================

    // 14. Criar Pedido (Público / Cliente autenticado)
    if (pathname === '/api/pedidos' && method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { cliente, itens, subtotal, frete, total, metodoPagamento, observacoes } = body;

            if (!cliente || !cliente.nome || !cliente.whatsapp) {
                return sendJson(res, 400, { success: false, error: 'Dados do cliente são obrigatórios.' });
            }

            if (!itens || !Array.isArray(itens) || itens.length === 0) {
                return sendJson(res, 400, { success: false, error: 'O pedido deve conter pelo menos um item.' });
            }

            let pedidos = [];
            if (fs.existsSync(PEDIDOS_FILE)) {
                try { pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8')); } catch (e) { pedidos = []; }
            }

            const numRandom = Math.floor(1000 + Math.random() * 9000);
            const orderId = `BOS-${numRandom}`;

            const novoPedido = {
                id: orderId,
                numero: `#${orderId}`,
                data: new Date().toISOString(),
                cliente: {
                    nome: cliente.nome,
                    email: cliente.email || '',
                    whatsapp: cliente.whatsapp,
                    endereco: cliente.endereco || {}
                },
                itens,
                subtotal: Number(subtotal) || 0,
                frete: frete || { tipo: 'SEDEX', valor: 0, prazo: '1 a 3 dias úteis' },
                total: Number(total) || 0,
                status: 'pendente', // pendente, pago, enviado, concluido, cancelado
                codigoRastreio: '',
                metodoPagamento: metodoPagamento || 'pix',
                chavePix: body.chavePix || '',
                linkCartao: body.linkCartao || '',
                observacoes: observacoes || ''
            };

            // Insere no topo da lista (mais recente primeiro)
            pedidos.unshift(novoPedido);
            fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2), 'utf8');

            console.log(`[PEDIDO] Novo pedido recebido: ${novoPedido.numero} por ${novoPedido.cliente.nome} (Total: R$ ${novoPedido.total.toFixed(2)})`);

            return sendJson(res, 201, {
                success: true,
                pedido: novoPedido,
                message: 'Pedido registrado com sucesso!'
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // 15. Listar Pedidos (Painel Admin - Requer Autenticação)
    if (pathname === '/api/pedidos' && method === 'GET') {
        const session = isAuthenticated(req);
        if (!session) {
            return sendJson(res, 401, { success: false, error: 'Acesso restrito ao administrador.' });
        }

        try {
            if (fs.existsSync(PEDIDOS_FILE)) {
                const data = fs.readFileSync(PEDIDOS_FILE, 'utf8');
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
            return sendJson(res, 500, { success: false, error: 'Erro ao ler arquivo de pedidos.' });
        }
    }

    // 16. Meus Pedidos (Cliente logado consulta seu histórico)
    if (pathname === '/api/pedidos/meus' && method === 'GET') {
        const clientSession = isClientAuthenticated(req);
        const emailQuery = parsedUrl.searchParams.get('email');
        const targetEmail = (clientSession && clientSession.email) || emailQuery;

        if (!targetEmail) {
            return sendJson(res, 400, { success: false, error: 'Identificação do cliente não informada.' });
        }

        try {
            let pedidos = [];
            if (fs.existsSync(PEDIDOS_FILE)) {
                try { pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8')); } catch (e) { pedidos = []; }
            }

            const meusPedidos = pedidos.filter(p => 
                p.cliente && p.cliente.email && p.cliente.email.toLowerCase() === targetEmail.toLowerCase()
            );

            return sendJson(res, 200, { success: true, pedidos: meusPedidos });
        } catch (err) {
            return sendJson(res, 500, { success: false, error: 'Erro ao buscar pedidos do cliente.' });
        }
    }

    // 17. Atualizar Status / Rastreio do Pedido (Admin)
    if (pathname.startsWith('/api/pedidos/') && method === 'PUT') {
        const session = isAuthenticated(req);
        if (!session) {
            return sendJson(res, 401, { success: false, error: 'Acesso restrito ao administrador.' });
        }

        const orderId = pathname.replace('/api/pedidos/', '').trim();
        try {
            const body = await parseJsonBody(req);
            let pedidos = [];
            if (fs.existsSync(PEDIDOS_FILE)) {
                try { pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8')); } catch (e) { pedidos = []; }
            }

            const idx = pedidos.findIndex(p => p.id === orderId || p.numero === orderId || p.numero === `#${orderId}`);
            if (idx === -1) {
                return sendJson(res, 404, { success: false, error: 'Pedido não encontrado.' });
            }

            if (body.status) pedidos[idx].status = body.status;
            if (body.codigoRastreio !== undefined) pedidos[idx].codigoRastreio = body.codigoRastreio.trim();
            if (body.observacoes !== undefined) pedidos[idx].observacoes = body.observacoes.trim();
            if (body.linkCartao !== undefined) pedidos[idx].linkCartao = body.linkCartao.trim();

            fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2), 'utf8');

            console.log(`[ADMIN] Pedido ${pedidos[idx].numero} atualizado por ${session.username} (Status: ${pedidos[idx].status})`);

            return sendJson(res, 200, {
                success: true,
                pedido: pedidos[idx],
                message: 'Pedido atualizado com sucesso!'
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // 18. Excluir Pedido (Admin)
    if (pathname.startsWith('/api/pedidos/') && method === 'DELETE') {
        const session = isAuthenticated(req);
        if (!session) {
            return sendJson(res, 401, { success: false, error: 'Acesso restrito ao administrador.' });
        }

        const orderId = pathname.replace('/api/pedidos/', '').trim();
        try {
            let pedidos = [];
            if (fs.existsSync(PEDIDOS_FILE)) {
                try { pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8')); } catch (e) { pedidos = []; }
            }

            const initialLen = pedidos.length;
            pedidos = pedidos.filter(p => p.id !== orderId && p.numero !== orderId && p.numero !== `#${orderId}`);

            if (pedidos.length === initialLen) {
                return sendJson(res, 404, { success: false, error: 'Pedido não encontrado.' });
            }

            fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2), 'utf8');

            console.log(`[ADMIN] Pedido ${orderId} excluído por ${session.username}`);

            return sendJson(res, 200, { success: true, message: 'Pedido excluído com sucesso.' });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // ==========================================
    // ROTAS CHECKOUT INTEGRADO INFINITEPAY
    // ==========================================

    // 19. Obter Configuração InfinitePay
    if (pathname === '/api/infinitepay/config' && method === 'GET') {
        const cfg = getInfinitePayConfig();
        return sendJson(res, 200, {
            success: true,
            config: cfg
        });
    }

    // 20. Salvar Configuração InfinitePay (Admin)
    if (pathname === '/api/infinitepay/config' && method === 'POST') {
        const session = isAuthenticated(req);
        if (!session) {
            return sendJson(res, 401, { success: false, error: 'Acesso restrito ao administrador.' });
        }

        try {
            const body = await parseJsonBody(req);
            const currentCfg = getInfinitePayConfig();
            const updatedCfg = {
                ...currentCfg,
                enabled: body.enabled !== undefined ? Boolean(body.enabled) : currentCfg.enabled,
                handle: (body.handle !== undefined ? String(body.handle).replace(/^\$/, '').trim() : currentCfg.handle) || DEFAULT_INFINITEPAY_CONFIG.handle,
                apiKey: (body.apiKey !== undefined ? String(body.apiKey).trim() : currentCfg.apiKey) || DEFAULT_INFINITEPAY_CONFIG.apiKey,
                updatedAt: new Date().toISOString()
            };
            fs.writeFileSync(INFINITEPAY_CONFIG_FILE, JSON.stringify(updatedCfg, null, 2), 'utf8');
            console.log(`[INFINITEPAY] Configuração atualizada por ${session.username} (Handle: ${updatedCfg.handle})`);
            return sendJson(res, 200, {
                success: true,
                config: updatedCfg,
                message: 'Configuração da API InfinitePay salva com sucesso!'
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // 21. Gerar Link de Checkout Integrado via API InfinitePay
    if (pathname === '/api/infinitepay/checkout' && method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const cfg = getInfinitePayConfig();
            const apiKey = body.apiKey || cfg.apiKey || DEFAULT_INFINITEPAY_CONFIG.apiKey;
            const proto = req.headers['x-forwarded-proto'] || 'http';
            const host = req.headers.host || `localhost:${PORT}`;
            const origin = `${proto}://${host}`;

            const fullPayload = buildInfinitePayCheckoutPayload(body, origin, cfg);
            if (!fullPayload.items || fullPayload.items.length === 0) {
                return sendJson(res, 400, {
                    success: false,
                    error: 'O pedido precisa conter pelo menos 1 item com valor válido.'
                });
            }

            const headers = {
                'X-Api-Key': apiKey
            };

            const endpoints = [
                cfg.checkoutEndpoint || 'https://api.checkout.infinitepay.io/links',
                cfg.fallbackEndpoint || 'https://api.infinitepay.io/invoices/public/checkout/links'
            ];

            let checkoutUrl = null;
            let invoiceSlug = '';
            let usedEndpoint = '';
            let lastErr = '';

            for (const endpoint of endpoints) {
                try {
                    const resp = await httpsPostJson(endpoint, fullPayload, headers);
                    const urlCandidate = resp.data && (resp.data.url || resp.data.checkout_url || resp.data.link);
                    if (resp.ok && urlCandidate) {
                        checkoutUrl = urlCandidate;
                        invoiceSlug = resp.data.slug || resp.data.invoice_slug || '';
                        usedEndpoint = endpoint;
                        break;
                    }

                    // Fallback enxuto (sem customer/address caso o telefone/CEP do cliente tenha formato inválido na validação estrita)
                    const minimalPayload = {
                        handle: fullPayload.handle,
                        order_nsu: fullPayload.order_nsu,
                        redirect_url: fullPayload.redirect_url,
                        items: fullPayload.items
                    };
                    const respMin = await httpsPostJson(endpoint, minimalPayload, headers);
                    const urlMin = respMin.data && (respMin.data.url || respMin.data.checkout_url || respMin.data.link);
                    if (respMin.ok && urlMin) {
                        checkoutUrl = urlMin;
                        invoiceSlug = respMin.data.slug || respMin.data.invoice_slug || '';
                        usedEndpoint = endpoint;
                        break;
                    }

                    lastErr = (resp.data && (resp.data.message || resp.data.error)) ||
                              (respMin.data && (respMin.data.message || respMin.data.error)) ||
                              `HTTP ${resp.status}`;
                } catch (e) {
                    lastErr = e.message;
                }
            }

            if (!checkoutUrl) {
                return sendJson(res, 502, {
                    success: false,
                    error: lastErr || 'Não foi possível gerar o link na API da InfinitePay.'
                });
            }

            // Se o pedido existir em pedidos.json, vincula o link gerado e o slug
            if (fs.existsSync(PEDIDOS_FILE)) {
                try {
                    const pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8'));
                    const idx = pedidos.findIndex(p =>
                        p.id === fullPayload.order_nsu ||
                        p.numero === fullPayload.order_nsu ||
                        p.numero === `#${fullPayload.order_nsu}`
                    );
                    if (idx !== -1) {
                        pedidos[idx].linkCartao = checkoutUrl;
                        pedidos[idx].infinitePayUrl = checkoutUrl;
                        if (invoiceSlug) pedidos[idx].invoiceSlug = invoiceSlug;
                        fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2), 'utf8');
                    }
                } catch (e) {}
            }

            console.log(`[INFINITEPAY] Link de checkout gerado para ${fullPayload.order_nsu}: ${checkoutUrl}`);
            return sendJson(res, 200, {
                success: true,
                url: checkoutUrl,
                slug: invoiceSlug,
                order_nsu: fullPayload.order_nsu,
                endpoint: usedEndpoint
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }

    // 22. Verificar Status de Pagamento na InfinitePay (payment_check)
    if (pathname === '/api/infinitepay/payment-check' && method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const cfg = getInfinitePayConfig();
            const apiKey = body.apiKey || cfg.apiKey || DEFAULT_INFINITEPAY_CONFIG.apiKey;
            const handle = String(body.handle || cfg.handle || DEFAULT_INFINITEPAY_CONFIG.handle).replace(/^\$/, '').trim();
            const order_nsu = String(body.order_nsu || body.orderId || '').replace(/^#/, '').trim();
            const transaction_nsu = String(body.transaction_nsu || '').trim();
            const slug = String(body.slug || body.invoice_slug || '').trim();
            const receipt_url = String(body.receipt_url || '').trim();

            const checkPayload = { handle, order_nsu, transaction_nsu, slug };
            const headers = { 'X-Api-Key': apiKey };
            const endpoints = [
                cfg.paymentCheckEndpoint || 'https://api.checkout.infinitepay.io/payment_check',
                cfg.fallbackPaymentCheckEndpoint || 'https://api.infinitepay.io/invoices/public/checkout/payment_check'
            ];

            let isPaid = false;
            let captureMethod = body.capture_method || '';
            let apiResponse = null;

            for (const endpoint of endpoints) {
                try {
                    const resp = await httpsPostJson(endpoint, checkPayload, headers);
                    if (resp.ok && resp.data) {
                        apiResponse = resp.data;
                        if (resp.data.paid || resp.data.success) {
                            isPaid = true;
                            captureMethod = resp.data.capture_method || captureMethod || 'infinitepay';
                            break;
                        }
                    }
                } catch (e) {}
            }

            // Se o redirecionamento trouxe transaction_nsu e slug válidos
            if (!isPaid && transaction_nsu && slug) {
                isPaid = true;
                captureMethod = captureMethod || 'infinitepay';
            }

            let updatedOrder = null;
            if (isPaid && order_nsu && fs.existsSync(PEDIDOS_FILE)) {
                try {
                    const pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8'));
                    const idx = pedidos.findIndex(p =>
                        p.id === order_nsu ||
                        p.numero === order_nsu ||
                        p.numero === `#${order_nsu}`
                    );
                    if (idx !== -1) {
                        pedidos[idx].status = 'pago';
                        pedidos[idx].pagoEm = new Date().toISOString();
                        if (transaction_nsu) pedidos[idx].transactionNsu = transaction_nsu;
                        if (slug) pedidos[idx].invoiceSlug = slug;
                        if (receipt_url) pedidos[idx].receiptUrl = receipt_url;
                        if (captureMethod) {
                            pedidos[idx].metodoPagamento = captureMethod === 'pix' ? 'pix' : 'cartao';
                            pedidos[idx].captureMethod = captureMethod;
                        }
                        fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2), 'utf8');
                        updatedOrder = pedidos[idx];
                        console.log(`[INFINITEPAY] Pagamento confirmado para o pedido ${pedidos[idx].numero} (${captureMethod})`);
                    }
                } catch (e) {}
            }

            return sendJson(res, 200, {
                success: true,
                paid: isPaid,
                capture_method: captureMethod,
                order_nsu,
                transaction_nsu,
                slug,
                receipt_url,
                pedido: updatedOrder,
                raw: apiResponse
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, paid: false, error: err.message });
        }
    }

    // 23. Webhook Oficial InfinitePay
    if (pathname === '/api/infinitepay/webhook' && method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const orderNsu = String(body.order_nsu || '').replace(/^#/, '').trim();
            const invoiceSlug = String(body.invoice_slug || body.slug || '').trim();
            const transactionNsu = String(body.transaction_nsu || '').trim();
            const captureMethod = String(body.capture_method || 'infinitepay').trim();
            const receiptUrl = String(body.receipt_url || '').trim();

            if (orderNsu && fs.existsSync(PEDIDOS_FILE)) {
                try {
                    const pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8'));
                    const idx = pedidos.findIndex(p =>
                        p.id === orderNsu ||
                        p.numero === orderNsu ||
                        p.numero === `#${orderNsu}`
                    );
                    if (idx !== -1) {
                        pedidos[idx].status = 'pago';
                        pedidos[idx].pagoEm = new Date().toISOString();
                        if (invoiceSlug) pedidos[idx].invoiceSlug = invoiceSlug;
                        if (transactionNsu) pedidos[idx].transactionNsu = transactionNsu;
                        if (receiptUrl) pedidos[idx].receiptUrl = receiptUrl;
                        pedidos[idx].captureMethod = captureMethod;
                        pedidos[idx].metodoPagamento = captureMethod === 'pix' ? 'pix' : 'cartao';
                        fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2), 'utf8');
                        console.log(`[WEBHOOK INFINITEPAY] Pedido ${pedidos[idx].numero} atualizado automaticamente para PAGO (${captureMethod})`);
                    }
                } catch (e) {
                    console.error('[WEBHOOK INFINITEPAY] Erro ao atualizar pedido:', e);
                }
            }

            return sendJson(res, 200, {
                success: true,
                received: true,
                order_nsu: orderNsu
            });
        } catch (err) {
            return sendJson(res, 400, { success: false, error: err.message });
        }
    }
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

        // Para páginas HTML, injeta o script de Live Reload automático
        if (ext === '.html') {
            fs.readFile(targetPath, 'utf8', (readErr, content) => {
                if (readErr) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
                    res.end('Erro ao carregar arquivo HTML.');
                    return;
                }
                const liveReloadSnippet = `\n<!-- Live Reload Automático -->\n<script id="__livereload_script">(() => { let s; function c() { s = new EventSource('/__livereload'); s.onmessage = (e) => { if (e.data === 'reload') { console.log('[LiveReload] Atualizando página...'); location.reload(); } }; s.onerror = () => { s.close(); setTimeout(c, 1500); }; } c(); })();</script>\n`;
                let finalHtml = content;
                if (content.includes('</body>')) {
                    finalHtml = content.replace('</body>', `${liveReloadSnippet}</body>`);
                } else {
                    finalHtml += liveReloadSnippet;
                }

                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                });
                res.end(finalHtml);
            });
            return;
        }

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
            serveFile(fallbackPath);
        });
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        const currentPort = server.address() ? server.address().port : PORT;
        const nextPort = Number(currentPort || PORT) + 1;
        console.warn(`⚠️ Porta ${PORT} em uso. Tentando iniciar automaticamente na porta ${nextPort}...`);
        setTimeout(() => {
            server.listen(nextPort, '0.0.0.0');
        }, 300);
    } else {
        console.error('Erro no servidor:', err);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    const actualPort = server.address().port;
    console.log(`\n🚀 Servidor local iniciado com sucesso!`);
    console.log(`📡 URL Local:      http://localhost:${actualPort}`);
    console.log(`🔒 Painel Admin:   http://localhost:${actualPort}/admin`);
    console.log(`⚡ Live Reload:    Ativo (atualização em tempo real ao salvar arquivos)`);
    console.log(`📂 Diretório:      ${PUBLIC_DIR}`);
    console.log(`Pressione Ctrl+C para encerrar o servidor.\n`);
});
