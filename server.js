const http = require('http');
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
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'assets', 'images');

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
    console.log(`📂 Diretório:      ${PUBLIC_DIR}`);
    console.log(`Pressione Ctrl+C para encerrar o servidor.\n`);
});
