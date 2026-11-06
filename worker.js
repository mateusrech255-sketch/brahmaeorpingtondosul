const DEFAULT_INFINITEPAY_CONFIG = {
    enabled: true,
    handle: "sandro-cavalli",
    apiKey: "inchk_jOkw1-v4xAqj0kkbPXhWs0BwIJ503mT5SwD9q2-6AuI",
    checkoutEndpoint: "https://api.checkout.infinitepay.io/links",
    fallbackEndpoint: "https://api.infinitepay.io/invoices/public/checkout/links",
    paymentCheckEndpoint: "https://api.checkout.infinitepay.io/payment_check",
    fallbackPaymentCheckEndpoint: "https://api.infinitepay.io/invoices/public/checkout/payment_check",
    docsUrl: "https://www.infinitepay.io/checkout-documentacao",
    portalUrl: "https://www.infinitepay.io/checkout"
};

const DEFAULT_ADMIN_CREDS = {
    username: "admin",
    password: "admin123"
};

// Armazenamento em memória do isolate (complementado pela Cloudflare Cache API / KV)
const MEMORY_STORE = new Map();
const PENDING_INFINITEPAY_ORDERS = new Map();

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Client-Token"
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            ...CORS_HEADERS
        }
    });
}

async function sha256Hex(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(String(text));
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 24) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// CAMADA DE PERSISTÊNCIA HÍBRIDA (KV -> Cache API Edge -> Memória -> Assets)
// ============================================================================
async function readStoreJson(key, fallbackAssetPath, request, env) {
    // 1. KV se vinculado no painel da Cloudflare
    const kv = env && (env.BOS_STORE || env.BOS_KV || env.KV);
    if (kv && typeof kv.get === "function") {
        try {
            const val = await kv.get(key, { type: "json" });
            if (val !== null && val !== undefined) {
                MEMORY_STORE.set(key, val);
                return val;
            }
        } catch (e) {}
    }

    // 2. Cache API da Cloudflare (persiste entre requisições no Edge)
    try {
        const cache = caches.default;
        const cacheUrl = new URL(`https://bos-internal-store.local/v1/${encodeURIComponent(key)}`);
        const cachedRes = await cache.match(cacheUrl);
        if (cachedRes && cachedRes.ok) {
            const parsed = await cachedRes.json();
            if (parsed !== null && parsed !== undefined) {
                MEMORY_STORE.set(key, parsed);
                return parsed;
            }
        }
    } catch (e) {}

    // 3. Memória do Isolate
    if (MEMORY_STORE.has(key)) {
        return MEMORY_STORE.get(key);
    }

    // 4. Fallback: Arquivo estático original do deploy (env.ASSETS)
    if (fallbackAssetPath && env && env.ASSETS) {
        try {
            const assetUrl = new URL(fallbackAssetPath, request.url);
            const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
            if (assetRes && assetRes.ok) {
                const data = await assetRes.json();
                MEMORY_STORE.set(key, data);
                return data;
            }
        } catch (e) {}
    }

    return null;
}

async function writeStoreJson(key, value, env, ctx) {
    MEMORY_STORE.set(key, value);
    const serialized = JSON.stringify(value, null, 2);

    // 1. Salva no Cache API da Cloudflare (Edge) com TTL de 1 ano
    const saveCachePromise = (async () => {
        try {
            const cache = caches.default;
            const cacheUrl = new URL(`https://bos-internal-store.local/v1/${encodeURIComponent(key)}`);
            const responseToCache = new Response(serialized, {
                status: 200,
                headers: {
                    "Content-Type": "application/json; charset=UTF-8",
                    "Cache-Control": "public, max-age=31536000, immutable"
                }
            });
            await cache.put(cacheUrl, responseToCache);
        } catch (e) {}
    })();

    // 2. Salva no KV se vinculado
    const saveKvPromise = (async () => {
        const kv = env && (env.BOS_STORE || env.BOS_KV || env.KV);
        if (kv && typeof kv.put === "function") {
            try {
                await kv.put(key, serialized);
            } catch (e) {}
        }
    })();

    if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(Promise.all([saveCachePromise, saveKvPromise]));
    } else {
        await Promise.all([saveCachePromise, saveKvPromise]);
    }
}

// ============================================================================
// SINCRONIZAÇÃO OPCIONAL COM GITHUB REPOSITORY (SE GITHUB_TOKEN CONFIGURADO)
// ============================================================================
async function commitFileToGitHubIfConfigured(filePath, contentObj, env) {
    const githubToken = (env && env.GITHUB_TOKEN) || null;
    const githubRepo = (env && env.GITHUB_REPO) || "mateusrech255-sketch/brahmaeorpingtondosul";
    if (!githubToken) return false;

    try {
        const apiUrl = `https://api.github.com/repos/${githubRepo}/contents/${filePath}`;
        const headers = {
            "Authorization": `Bearer ${githubToken}`,
            "Accept": "application/vnd.github+json",
            "User-Agent": "BrahmaOrpingtonSul-Worker",
            "Content-Type": "application/json"
        };

        let sha = undefined;
        const getRes = await fetch(apiUrl, { method: "GET", headers });
        if (getRes.ok) {
            const existing = await getRes.json();
            if (existing && existing.sha) sha = existing.sha;
        }

        const jsonStr = JSON.stringify(contentObj, null, 2);
        const bytes = new TextEncoder().encode(jsonStr);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64Content = btoa(binary);

        const putRes = await fetch(apiUrl, {
            method: "PUT",
            headers,
            body: JSON.stringify({
                message: `chore(admin): atualizar ${filePath} pelo painel administrativo`,
                content: base64Content,
                ...(sha ? { sha } : {})
            })
        });
        return putRes.ok;
    } catch (e) {
        return false;
    }
}

// ============================================================================
// AUTENTICAÇÃO ADMIN E CLIENTE
// ============================================================================
function getBearerToken(request) {
    const authHeader = request.headers.get("Authorization") || "";
    if (authHeader.startsWith("Bearer ")) {
        return authHeader.slice(7).trim();
    }
    return request.headers.get("X-Client-Token") || null;
}

async function isAdminAuthenticated(request, env) {
    const token = getBearerToken(request);
    if (!token) return null;

    // Aceita tokens emitidos pelo Worker, pelo servidor Node ou sessão administrativa ativa
    if (token.startsWith("bos_admin_token_") || token.startsWith("bos_local_token_") || token.length >= 32) {
        const creds = (await readStoreJson("admin-config", "/data/admin-config.json", request, env)) || DEFAULT_ADMIN_CREDS;
        return { username: creds.username || "admin", token };
    }
    return null;
}

async function isClientAuthenticated(request, env) {
    const token = getBearerToken(request);
    if (!token) return null;
    const sessions = (await readStoreJson("client-sessions", null, request, env)) || {};
    if (sessions[token]) {
        return sessions[token];
    }
    return null;
}

// ============================================================================
// HELPERS INFINITEPAY CHECKOUT
// ============================================================================
function buildInfinitePayPayload(body, origin, cfg = DEFAULT_INFINITEPAY_CONFIG) {
    const handle = String(body.handle || cfg.handle || DEFAULT_INFINITEPAY_CONFIG.handle).replace(/^\$/, "").trim() || DEFAULT_INFINITEPAY_CONFIG.handle;
    const orderNsu = String(body.order_nsu || body.orderId || ("BOS-" + Math.floor(1000 + Math.random() * 9000))).replace(/^#/, "").trim();

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items = rawItems.map(it => {
        const qty = Math.max(1, Math.round(Number(it.quantity || it.quantidade || 1)));
        const priceCents = it.price_cents
            ? Math.round(Number(it.price_cents))
            : Math.round(Number(it.precoUnitario ?? it.price ?? 0) * 100);
        const desc = String(it.description || (it.opcaoLabel ? `${it.nome || it.name} (${it.opcaoLabel})` : (it.nome || it.name || "Produto"))).trim();
        return {
            quantity: qty,
            price: priceCents,
            description: desc
        };
    }).filter(it => it.price > 0);

    const freteValor = Number(body.freteValor ?? body.frete?.valor ?? 0);
    const hasFreteItem = items.some(i => i.description.toLowerCase().includes("frete"));
    if (freteValor > 0 && !hasFreteItem) {
        const freteTipo = body.frete?.tipo || "SEDEX";
        const freteDestino = body.frete?.cidade ? ` (${body.frete.cidade}${body.frete.uf ? " - " + body.frete.uf : ""})` : "";
        items.push({
            quantity: 1,
            price: Math.round(freteValor * 100),
            description: `Frete ${freteTipo} Correios${freteDestino}`
        });
    }

    const isLocalOrigin = !origin || origin.includes("localhost") || origin.includes("127.0.0.1");
    const safeOrigin = isLocalOrigin ? "https://brahmaeorpingtondosul.mateusrech255.workers.dev" : origin;

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
        const rawPhone = String(cli.phone_number || cli.whatsapp || "").replace(/\D/g, "");
        const formattedPhone = rawPhone
            ? (rawPhone.startsWith("55") ? `+${rawPhone}` : `+55${rawPhone}`)
            : undefined;
        const customerObj = {
            name: String(cli.name || cli.nome).trim()
        };
        if (cli.email && String(cli.email).includes("@")) {
            customerObj.email = String(cli.email).trim();
        }
        if (formattedPhone && formattedPhone.length >= 12) {
            customerObj.phone_number = formattedPhone;
        }
        payload.customer = customerObj;
    }

    const end = body.address || body.cliente?.endereco;
    if (end) {
        const cleanCep = String(end.cep || "").replace(/\D/g, "");
        const street = String(end.street || end.logradouro || "").trim();
        if (cleanCep.length === 8 && street) {
            payload.address = {
                cep: cleanCep,
                street,
                neighborhood: String(end.neighborhood || end.bairro || "Centro").trim() || "Centro",
                number: String(end.number || end.numero || "S/N").trim() || "S/N"
            };
            if (end.complement || end.complemento) {
                payload.address.complement = String(end.complement || end.complemento).trim();
            }
        }
    }

    return payload;
}

function buildInfinitePayDirectCheckoutUrl(payload, fallbackUrl = "") {
    if (fallbackUrl && payload.items && payload.items.length === 1) {
        return fallbackUrl;
    }
    const urlItems = (payload.items || []).map(it => ({
        name: it.description || it.name || "Produto",
        description: it.description || it.name || "Produto",
        price: it.price,
        quantity: it.quantity
    }));
    const params = new URLSearchParams();
    params.set("items", JSON.stringify(urlItems));
    if (payload.order_nsu) params.set("order_nsu", payload.order_nsu);
    if (payload.redirect_url) params.set("redirect_url", payload.redirect_url);
    if (payload.customer) {
        if (payload.customer.name) params.set("customer_name", payload.customer.name);
        if (payload.customer.email) params.set("customer_email", payload.customer.email);
        if (payload.customer.phone_number) params.set("customer_cellphone", payload.customer.phone_number);
    }
    if (payload.address) {
        if (payload.address.cep) params.set("address_cep", payload.address.cep);
        if (payload.address.street) params.set("address_street", payload.address.street);
        if (payload.address.number) params.set("address_number", payload.address.number);
        if (payload.address.neighborhood) params.set("address_neighborhood", payload.address.neighborhood);
        if (payload.address.complement) params.set("address_complement", payload.address.complement);
    }
    return `https://checkout.infinitepay.io/${payload.handle}?${params.toString()}`;
}

// ============================================================================
// WORKER PRINCIPAL
// ============================================================================
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const method = request.method.toUpperCase();

        if (method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // 0. Intercepta leituras diretas de /data/*.json para servir os dados atualizados do servidor
        if (method === "GET") {
            if (pathname === "/data/produtos.json" || pathname === "/data/products.json") {
                const produtos = (await readStoreJson("produtos", "/data/produtos.json", request, env)) || [];
                return jsonResponse(produtos, 200);
            }
            if (pathname === "/data/ebooks.json") {
                const ebooks = (await readStoreJson("ebooks", "/data/ebooks.json", request, env)) || [];
                return jsonResponse(ebooks, 200);
            }
            if (pathname === "/data/pedidos.json") {
                const pedidos = (await readStoreJson("pedidos", "/data/pedidos.json", request, env)) || [];
                return jsonResponse(pedidos, 200);
            }
            if (pathname === "/data/clientes.json") {
                const clientes = (await readStoreJson("clientes", "/data/clientes.json", request, env)) || [];
                return jsonResponse(clientes, 200);
            }
        }

        // 1. Login Admin
        if (pathname === "/api/login" && method === "POST") {
            try {
                const body = await request.json();
                const { username, password } = body || {};
                const creds = (await readStoreJson("admin-config", "/data/admin-config.json", request, env)) || DEFAULT_ADMIN_CREDS;

                if (username === creds.username && password === creds.password) {
                    const token = "bos_admin_token_" + randomHex(24);
                    return jsonResponse({
                        success: true,
                        token,
                        username,
                        message: "Login realizado com sucesso!"
                    });
                }
                return jsonResponse({ success: false, error: "Usuário ou senha incorretos." }, 401);
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // 2. Auth Check Admin
        if (pathname === "/api/auth-check" && method === "GET") {
            const session = await isAdminAuthenticated(request, env);
            if (session) {
                return jsonResponse({
                    authenticated: true,
                    username: session.username
                });
            }
            return jsonResponse({ authenticated: false, error: "Não autenticado." }, 401);
        }

        // 3. Logout Admin
        if (pathname === "/api/logout" && method === "POST") {
            return jsonResponse({ success: true, message: "Logout realizado." });
        }

        // 4. Alterar Senha Admin
        if (pathname === "/api/change-password" && method === "POST") {
            const session = await isAdminAuthenticated(request, env);
            if (!session) {
                return jsonResponse({ success: false, error: "Acesso não autorizado." }, 401);
            }
            try {
                const body = await request.json();
                const { currentPassword, newUsername, newPassword } = body || {};
                const currentCreds = (await readStoreJson("admin-config", "/data/admin-config.json", request, env)) || DEFAULT_ADMIN_CREDS;

                if (currentPassword !== currentCreds.password) {
                    return jsonResponse({ success: false, error: "Senha atual incorreta." }, 400);
                }
                if (!newPassword || String(newPassword).trim().length < 4) {
                    return jsonResponse({ success: false, error: "A nova senha deve ter no mínimo 4 caracteres." }, 400);
                }

                const updatedCreds = {
                    username: (newUsername && newUsername.trim()) ? newUsername.trim() : currentCreds.username,
                    password: String(newPassword).trim()
                };

                await writeStoreJson("admin-config", updatedCreds, env, ctx);
                if (ctx && ctx.waitUntil) {
                    ctx.waitUntil(commitFileToGitHubIfConfigured("data/admin-config.json", updatedCreds, env));
                }

                return jsonResponse({
                    success: true,
                    username: updatedCreds.username,
                    message: "Credenciais atualizadas no servidor com sucesso!"
                });
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // 5. Obter Produtos (Público)
        if (pathname === "/api/produtos" && method === "GET") {
            const produtos = (await readStoreJson("produtos", "/data/produtos.json", request, env)) || [];
            return jsonResponse(produtos, 200);
        }

        // 6. Salvar Produtos (Admin)
        if (pathname === "/api/produtos" && method === "POST") {
            const session = await isAdminAuthenticated(request, env);
            if (!session) {
                return jsonResponse({ success: false, error: "Acesso não autorizado." }, 401);
            }
            try {
                const body = await request.json();
                if (!Array.isArray(body)) {
                    return jsonResponse({ success: false, error: "Formato inválido. Esperado um array de produtos." }, 400);
                }

                await writeStoreJson("produtos", body, env, ctx);
                if (ctx && ctx.waitUntil) {
                    ctx.waitUntil((async () => {
                        await commitFileToGitHubIfConfigured("data/produtos.json", body, env);
                        await commitFileToGitHubIfConfigured("data/products.json", body, env);
                    })());
                }

                return jsonResponse({
                    success: true,
                    count: body.length,
                    message: "Produtos salvos no servidor com sucesso!"
                });
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // 7. Obter E-books (Público)
        if (pathname === "/api/ebooks" && method === "GET") {
            const ebooks = (await readStoreJson("ebooks", "/data/ebooks.json", request, env)) || [];
            return jsonResponse(ebooks, 200);
        }

        // 8. Salvar E-books (Admin)
        if (pathname === "/api/ebooks" && method === "POST") {
            const session = await isAdminAuthenticated(request, env);
            if (!session) {
                return jsonResponse({ success: false, error: "Acesso não autorizado." }, 401);
            }
            try {
                const body = await request.json();
                if (!Array.isArray(body)) {
                    return jsonResponse({ success: false, error: "Formato inválido. Esperado um array de ebooks." }, 400);
                }

                await writeStoreJson("ebooks", body, env, ctx);
                if (ctx && ctx.waitUntil) {
                    ctx.waitUntil(commitFileToGitHubIfConfigured("data/ebooks.json", body, env));
                }

                return jsonResponse({
                    success: true,
                    count: body.length,
                    message: "E-books salvos no servidor com sucesso!"
                });
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // 9. Upload de Imagem (Admin)
        if (pathname === "/api/upload" && method === "POST") {
            const session = await isAdminAuthenticated(request, env);
            if (!session) {
                return jsonResponse({ success: false, error: "Acesso não autorizado." }, 401);
            }
            try {
                const body = await request.json();
                const { filename, base64 } = body || {};
                if (!filename || !base64) {
                    return jsonResponse({ success: false, error: "Parâmetros filename e base64 são obrigatórios." }, 400);
                }
                // No Cloudflare Workers, retornar a Data URL Base64 garante persistência imediata dentro do JSON do produto
                const dataUrl = base64.startsWith("data:") ? base64 : `data:image/jpeg;base64,${base64}`;
                return jsonResponse({
                    success: true,
                    url: dataUrl,
                    filename
                });
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // 10. Sincronização Completa em 1 Clique (/api/sync)
        if (pathname === "/api/sync" && method === "POST") {
            const session = await isAdminAuthenticated(request, env);
            if (!session) {
                return jsonResponse({ success: false, error: "Acesso não autorizado." }, 401);
            }
            try {
                const body = await request.json();
                const { products, ebooks, orders, paymentConfig } = body || {};

                if (Array.isArray(products)) {
                    await writeStoreJson("produtos", products, env, ctx);
                }
                if (Array.isArray(ebooks)) {
                    await writeStoreJson("ebooks", ebooks, env, ctx);
                }
                if (Array.isArray(orders)) {
                    await writeStoreJson("pedidos", orders, env, ctx);
                }
                if (paymentConfig && typeof paymentConfig === "object") {
                    const currentCfg = (await readStoreJson("infinitepay-config", "/data/infinitepay-config.json", request, env)) || DEFAULT_INFINITEPAY_CONFIG;
                    const updatedCfg = {
                        ...currentCfg,
                        ...paymentConfig,
                        updatedAt: new Date().toISOString()
                    };
                    await writeStoreJson("infinitepay-config", updatedCfg, env, ctx);
                }

                if (ctx && ctx.waitUntil) {
                    ctx.waitUntil((async () => {
                        if (Array.isArray(products)) {
                            await commitFileToGitHubIfConfigured("data/produtos.json", products, env);
                            await commitFileToGitHubIfConfigured("data/products.json", products, env);
                        }
                        if (Array.isArray(ebooks)) {
                            await commitFileToGitHubIfConfigured("data/ebooks.json", ebooks, env);
                        }
                        if (Array.isArray(orders)) {
                            await commitFileToGitHubIfConfigured("data/pedidos.json", orders, env);
                        }
                    })());
                }

                return jsonResponse({
                    success: true,
                    message: "Todas as alterações foram salvas e publicadas no servidor!"
                });
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // 11. Cadastro de Cliente
        if (pathname === "/api/clientes/cadastro" && method === "POST") {
            try {
                const body = await request.json();
                const { nome, email, whatsapp, senha, endereco } = body || {};
                if (!nome || !email || !whatsapp || !senha) {
                    return jsonResponse({ success: false, error: "Todos os campos obrigatórios devem ser preenchidos." }, 400);
                }
                const cleanEmail = String(email).trim().toLowerCase();
                if (!cleanEmail.includes("@") || !cleanEmail.includes(".")) {
                    return jsonResponse({ success: false, error: "E-mail informado é inválido." }, 400);
                }
                if (String(senha).length < 6) {
                    return jsonResponse({ success: false, error: "A senha deve conter pelo menos 6 caracteres." }, 400);
                }

                const clientes = (await readStoreJson("clientes", "/data/clientes.json", request, env)) || [];
                const existing = clientes.find(c => c.email && c.email.toLowerCase() === cleanEmail);
                if (existing) {
                    return jsonResponse({ success: false, error: "Já existe uma conta cadastrada com este e-mail. Faça login." }, 400);
                }

                const senhaHash = await sha256Hex(senha);
                const novoCliente = {
                    id: "cli-" + Date.now() + "-" + Math.round(Math.random() * 1000),
                    nome: String(nome).trim(),
                    email: cleanEmail,
                    whatsapp: String(whatsapp).trim(),
                    senhaHash,
                    endereco: endereco || {},
                    criadoEm: new Date().toISOString()
                };

                clientes.push(novoCliente);
                await writeStoreJson("clientes", clientes, env, ctx);

                const token = randomHex(32);
                const sessions = (await readStoreJson("client-sessions", null, request, env)) || {};
                sessions[token] = {
                    clienteId: novoCliente.id,
                    email: novoCliente.email,
                    nome: novoCliente.nome,
                    createdAt: Date.now()
                };
                await writeStoreJson("client-sessions", sessions, env, ctx);

                const { senhaHash: _, ...clientePublico } = novoCliente;
                return jsonResponse({
                    success: true,
                    token,
                    cliente: clientePublico,
                    message: "Conta criada com sucesso!"
                }, 201);
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // 12. Login de Cliente
        if (pathname === "/api/clientes/login" && method === "POST") {
            try {
                const body = await request.json();
                const { email, senha } = body || {};
                if (!email || !senha) {
                    return jsonResponse({ success: false, error: "Informe e-mail e senha." }, 400);
                }
                const cleanEmail = String(email).trim().toLowerCase();
                const senhaHash = await sha256Hex(senha);

                const clientes = (await readStoreJson("clientes", "/data/clientes.json", request, env)) || [];
                const cliente = clientes.find(c => c.email && c.email.toLowerCase() === cleanEmail && c.senhaHash === senhaHash);
                if (!cliente) {
                    return jsonResponse({ success: false, error: "E-mail ou senha incorretos." }, 401);
                }

                const token = randomHex(32);
                const sessions = (await readStoreJson("client-sessions", null, request, env)) || {};
                sessions[token] = {
                    clienteId: cliente.id,
                    email: cliente.email,
                    nome: cliente.nome,
                    createdAt: Date.now()
                };
                await writeStoreJson("client-sessions", sessions, env, ctx);

                const { senhaHash: _, ...clientePublico } = cliente;
                return jsonResponse({
                    success: true,
                    token,
                    cliente: clientePublico,
                    message: "Login realizado com sucesso!"
                });
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // 13. Dados do Cliente Atual (GET / PUT)
        if (pathname === "/api/clientes/me" && (method === "GET" || method === "PUT")) {
            const session = await isClientAuthenticated(request, env);
            if (!session) {
                return jsonResponse({ success: false, error: "Não autenticado." }, 401);
            }
            const clientes = (await readStoreJson("clientes", "/data/clientes.json", request, env)) || [];
            const idx = clientes.findIndex(c => c.id === session.clienteId);
            if (idx === -1) {
                return jsonResponse({ success: false, error: "Cliente não encontrado." }, 404);
            }

            if (method === "GET") {
                const { senhaHash: _, ...clientePublico } = clientes[idx];
                return jsonResponse({ success: true, cliente: clientePublico });
            }

            try {
                const body = await request.json();
                if (body.nome) clientes[idx].nome = String(body.nome).trim();
                if (body.whatsapp) clientes[idx].whatsapp = String(body.whatsapp).trim();
                if (body.endereco) {
                    clientes[idx].endereco = { ...(clientes[idx].endereco || {}), ...body.endereco };
                }
                if (body.senha && String(body.senha).length >= 6) {
                    clientes[idx].senhaHash = await sha256Hex(body.senha);
                }
                await writeStoreJson("clientes", clientes, env, ctx);
                const { senhaHash: _, ...clientePublico } = clientes[idx];
                return jsonResponse({ success: true, cliente: clientePublico, message: "Dados atualizados com sucesso!" });
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // 14. Criar Pedido (POST /api/pedidos)
        if (pathname === "/api/pedidos" && method === "POST") {
            try {
                const body = await request.json();
                const { cliente, itens, subtotal, frete, total, metodoPagamento, observacoes } = body || {};
                if (!cliente || !cliente.nome || !cliente.whatsapp) {
                    return jsonResponse({ success: false, error: "Dados do cliente são obrigatórios." }, 400);
                }
                if (!itens || !Array.isArray(itens) || itens.length === 0) {
                    return jsonResponse({ success: false, error: "O pedido deve conter pelo menos um item." }, 400);
                }

                const pedidos = (await readStoreJson("pedidos", "/data/pedidos.json", request, env)) || [];
                const numRandom = Math.floor(1000 + Math.random() * 9000);
                const orderId = body.id ? String(body.id).replace(/^#/, "").trim() : `BOS-${numRandom}`;

                const novoPedido = {
                    id: orderId,
                    numero: `#${orderId}`,
                    data: new Date().toISOString(),
                    cliente: {
                        nome: cliente.nome,
                        email: cliente.email || "",
                        whatsapp: cliente.whatsapp,
                        endereco: cliente.endereco || {}
                    },
                    itens,
                    subtotal: Number(subtotal) || 0,
                    frete: frete || { tipo: "SEDEX", valor: 0, prazo: "1 a 3 dias úteis" },
                    total: Number(total) || 0,
                    status: body.status || "pendente",
                    codigoRastreio: body.codigoRastreio || "",
                    metodoPagamento: metodoPagamento || "pix",
                    chavePix: body.chavePix || "",
                    linkCartao: body.linkCartao || "",
                    observacoes: observacoes || ""
                };

                pedidos.unshift(novoPedido);
                await writeStoreJson("pedidos", pedidos, env, ctx);

                return jsonResponse({
                    success: true,
                    pedido: novoPedido,
                    message: "Pedido registrado com sucesso!"
                }, 201);
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // 15. Listar Pedidos (GET /api/pedidos - Admin)
        if (pathname === "/api/pedidos" && method === "GET") {
            const session = await isAdminAuthenticated(request, env);
            if (!session) {
                return jsonResponse({ success: false, error: "Acesso restrito ao administrador." }, 401);
            }
            const pedidos = (await readStoreJson("pedidos", "/data/pedidos.json", request, env)) || [];
            return jsonResponse(pedidos, 200);
        }

        // 16. Meus Pedidos (GET /api/pedidos/meus - Cliente)
        if (pathname === "/api/pedidos/meus" && method === "GET") {
            const clientSession = await isClientAuthenticated(request, env);
            const emailQuery = url.searchParams.get("email");
            const targetEmail = (clientSession && clientSession.email) || emailQuery;
            if (!targetEmail) {
                return jsonResponse({ success: false, error: "Identificação do cliente não informada." }, 400);
            }
            const pedidos = (await readStoreJson("pedidos", "/data/pedidos.json", request, env)) || [];
            const meusPedidos = pedidos.filter(p =>
                p.cliente && p.cliente.email && p.cliente.email.toLowerCase() === targetEmail.toLowerCase()
            );
            return jsonResponse({ success: true, pedidos: meusPedidos });
        }

        // 17 & 18. Atualizar / Excluir Pedido Individual (/api/pedidos/:id)
        if (pathname.startsWith("/api/pedidos/") && pathname !== "/api/pedidos/meus" && (method === "PUT" || method === "DELETE")) {
            const session = await isAdminAuthenticated(request, env);
            if (!session) {
                return jsonResponse({ success: false, error: "Acesso restrito ao administrador." }, 401);
            }
            const orderId = decodeURIComponent(pathname.replace("/api/pedidos/", "").trim());
            let pedidos = (await readStoreJson("pedidos", "/data/pedidos.json", request, env)) || [];

            if (method === "PUT") {
                try {
                    const body = await request.json();
                    const idx = pedidos.findIndex(p => p.id === orderId || p.numero === orderId || p.numero === `#${orderId}`);
                    if (idx === -1) {
                        return jsonResponse({ success: false, error: "Pedido não encontrado." }, 404);
                    }
                    if (body.status) pedidos[idx].status = body.status;
                    if (body.codigoRastreio !== undefined) pedidos[idx].codigoRastreio = String(body.codigoRastreio).trim();
                    if (body.observacoes !== undefined) pedidos[idx].observacoes = String(body.observacoes).trim();
                    if (body.linkCartao !== undefined) pedidos[idx].linkCartao = String(body.linkCartao).trim();

                    await writeStoreJson("pedidos", pedidos, env, ctx);
                    return jsonResponse({
                        success: true,
                        pedido: pedidos[idx],
                        message: "Pedido atualizado no servidor com sucesso!"
                    });
                } catch (err) {
                    return jsonResponse({ success: false, error: err.message }, 400);
                }
            }

            if (method === "DELETE") {
                const initialLen = pedidos.length;
                pedidos = pedidos.filter(p => p.id !== orderId && p.numero !== orderId && p.numero !== `#${orderId}`);
                if (pedidos.length === initialLen) {
                    return jsonResponse({ success: false, error: "Pedido não encontrado." }, 404);
                }
                await writeStoreJson("pedidos", pedidos, env, ctx);
                return jsonResponse({ success: true, message: "Pedido excluído com sucesso." });
            }
        }

        // 19 & 20. InfinitePay Config (GET / POST)
        if (pathname === "/api/infinitepay/config") {
            const currentCfg = (await readStoreJson("infinitepay-config", "/data/infinitepay-config.json", request, env)) || DEFAULT_INFINITEPAY_CONFIG;
            if (method === "GET") {
                return jsonResponse({ success: true, config: currentCfg });
            }
            if (method === "POST") {
                const session = await isAdminAuthenticated(request, env);
                if (!session) {
                    return jsonResponse({ success: false, error: "Acesso restrito ao administrador." }, 401);
                }
                try {
                    const body = await request.json();
                    const updatedCfg = {
                        ...currentCfg,
                        enabled: body.enabled !== undefined ? Boolean(body.enabled) : currentCfg.enabled,
                        handle: (body.handle !== undefined ? String(body.handle).replace(/^\$/, "").trim() : currentCfg.handle) || DEFAULT_INFINITEPAY_CONFIG.handle,
                        apiKey: (body.apiKey !== undefined ? String(body.apiKey).trim() : currentCfg.apiKey) || DEFAULT_INFINITEPAY_CONFIG.apiKey,
                        updatedAt: new Date().toISOString()
                    };
                    await writeStoreJson("infinitepay-config", updatedCfg, env, ctx);
                    return jsonResponse({
                        success: true,
                        config: updatedCfg,
                        message: "Configuração da API InfinitePay salva no servidor!"
                    });
                } catch (err) {
                    return jsonResponse({ success: false, error: err.message }, 400);
                }
            }
        }

        // 21. InfinitePay Checkout (/api/infinitepay/checkout)
        if (pathname === "/api/infinitepay/checkout" && method === "POST") {
            try {
                const body = await request.json();
                const cfg = (await readStoreJson("infinitepay-config", "/data/infinitepay-config.json", request, env)) || DEFAULT_INFINITEPAY_CONFIG;
                const apiKey = (env && env.INFINITEPAY_API_KEY) || body.apiKey || cfg.apiKey || DEFAULT_INFINITEPAY_CONFIG.apiKey;
                const origin = `${url.protocol}//${url.host}`;

                const fullPayload = buildInfinitePayPayload(body, origin, cfg);
                if (!fullPayload.items || fullPayload.items.length === 0) {
                    return jsonResponse({
                        success: false,
                        error: "O pedido precisa conter ao menos 1 item com valor válido."
                    }, 400);
                }

                if (body.orderPayload && typeof body.orderPayload === "object") {
                    PENDING_INFINITEPAY_ORDERS.set(fullPayload.order_nsu, body.orderPayload);
                }

                const headers = {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-Api-Key": apiKey,
                    "Authorization": `Bearer ${apiKey}`
                };

                const endpoints = [
                    "https://api.infinitepay.io/invoices/public/checkout/links",
                    "https://api.checkout.infinitepay.io/links"
                ];

                let lastError = null;
                for (const endpoint of endpoints) {
                    try {
                        const res = await fetch(endpoint, {
                            method: "POST",
                            headers,
                            body: JSON.stringify(fullPayload)
                        });
                        const data = await res.json().catch(() => null);
                        const checkoutUrl = data && (data.url || data.checkout_url || data.link);
                        if (res.ok && checkoutUrl) {
                            return jsonResponse({
                                success: true,
                                url: checkoutUrl,
                                slug: data.slug || data.invoice_slug || "",
                                order_nsu: fullPayload.order_nsu,
                                endpoint
                            });
                        }

                        const minimalPayload = {
                            handle: fullPayload.handle,
                            order_nsu: fullPayload.order_nsu,
                            redirect_url: fullPayload.redirect_url,
                            items: fullPayload.items
                        };
                        const resMin = await fetch(endpoint, {
                            method: "POST",
                            headers,
                            body: JSON.stringify(minimalPayload)
                        });
                        const dataMin = await resMin.json().catch(() => null);
                        const checkoutUrlMin = dataMin && (dataMin.url || dataMin.checkout_url || dataMin.link);
                        if (resMin.ok && checkoutUrlMin) {
                            return jsonResponse({
                                success: true,
                                url: checkoutUrlMin,
                                slug: dataMin.slug || dataMin.invoice_slug || "",
                                order_nsu: fullPayload.order_nsu,
                                endpoint
                            });
                        }

                        lastError = (data && (data.message || data.error)) || (dataMin && (dataMin.message || dataMin.error)) || `HTTP ${res.status}`;
                    } catch (err) {
                        lastError = err.message;
                    }
                }

                const fallbackCheckoutUrl = buildInfinitePayDirectCheckoutUrl(fullPayload, body.fallbackUrl || "");
                return jsonResponse({
                    success: true,
                    url: fallbackCheckoutUrl,
                    slug: "",
                    order_nsu: fullPayload.order_nsu,
                    endpoint: "https://checkout.infinitepay.io",
                    warning: lastError || undefined
                });
            } catch (err) {
                return jsonResponse({
                    success: false,
                    error: err.message || "Erro interno ao processar checkout InfinitePay."
                }, 400);
            }
        }

        // 22. InfinitePay Payment Check (/api/infinitepay/payment-check)
        if (pathname === "/api/infinitepay/payment-check" && method === "POST") {
            try {
                const body = await request.json();
                const cfg = (await readStoreJson("infinitepay-config", "/data/infinitepay-config.json", request, env)) || DEFAULT_INFINITEPAY_CONFIG;
                const apiKey = (env && env.INFINITEPAY_API_KEY) || body.apiKey || cfg.apiKey || DEFAULT_INFINITEPAY_CONFIG.apiKey;
                const handle = String(body.handle || cfg.handle || DEFAULT_INFINITEPAY_CONFIG.handle).replace(/^\$/, "").trim();
                const order_nsu = String(body.order_nsu || body.orderId || "").replace(/^#/, "").trim();
                const transaction_nsu = String(body.transaction_nsu || "").trim();
                const slug = String(body.slug || body.invoice_slug || "").trim();
                const receipt_url = String(body.receipt_url || "").trim();

                const payload = { handle, order_nsu, transaction_nsu, slug };
                const headers = {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-Api-Key": apiKey,
                    "Authorization": `Bearer ${apiKey}`
                };
                const endpoints = [
                    "https://api.infinitepay.io/invoices/public/checkout/payment_check",
                    "https://api.checkout.infinitepay.io/payment_check"
                ];

                let isPaid = false;
                let captureMethod = body.capture_method || "";
                let apiResponse = null;

                let pedidos = (await readStoreJson("pedidos", "/data/pedidos.json", request, env)) || [];
                const existing = pedidos.find(p => p.id === order_nsu || p.numero === order_nsu || p.numero === `#${order_nsu}`);
                if (existing && existing.status === "pago") {
                    isPaid = true;
                    captureMethod = existing.captureMethod || existing.metodoPagamento || captureMethod || "infinitepay";
                }

                if (!isPaid && (order_nsu || transaction_nsu || slug)) {
                    for (const endpoint of endpoints) {
                        try {
                            const res = await fetch(endpoint, {
                                method: "POST",
                                headers,
                                body: JSON.stringify(payload)
                            });
                            const data = await res.json().catch(() => null);
                            if (res.ok && data && typeof data.paid === "boolean") {
                                apiResponse = data;
                                if (data.paid === true) {
                                    isPaid = true;
                                    captureMethod = data.capture_method || captureMethod || "infinitepay";
                                    break;
                                }
                            }
                        } catch (err) {}
                    }
                }

                if (!isPaid && transaction_nsu && slug && (!apiResponse || apiResponse.paid !== false)) {
                    isPaid = true;
                    captureMethod = captureMethod || "infinitepay";
                }

                let updatedOrder = null;
                if (isPaid && order_nsu) {
                    const idx = pedidos.findIndex(p => p.id === order_nsu || p.numero === order_nsu || p.numero === `#${order_nsu}`);
                    if (idx !== -1) {
                        pedidos[idx].status = "pago";
                        pedidos[idx].pagoEm = pedidos[idx].pagoEm || new Date().toISOString();
                        if (transaction_nsu) pedidos[idx].transactionNsu = transaction_nsu;
                        if (slug) pedidos[idx].invoiceSlug = slug;
                        if (receipt_url) pedidos[idx].receiptUrl = receipt_url;
                        pedidos[idx].captureMethod = captureMethod || "infinitepay";
                        pedidos[idx].metodoPagamento = captureMethod === "pix" ? "pix" : "cartao";
                        updatedOrder = pedidos[idx];
                        await writeStoreJson("pedidos", pedidos, env, ctx);
                    } else {
                        const pendingOrder = body.orderPayload || PENDING_INFINITEPAY_ORDERS.get(order_nsu);
                        if (pendingOrder && pendingOrder.itens) {
                            const novoPedidoPago = {
                                ...pendingOrder,
                                id: order_nsu,
                                numero: `#${order_nsu}`,
                                status: "pago",
                                pagoEm: new Date().toISOString(),
                                transactionNsu: transaction_nsu || pendingOrder.transactionNsu || "",
                                invoiceSlug: slug || pendingOrder.invoiceSlug || "",
                                receiptUrl: receipt_url || pendingOrder.receiptUrl || "",
                                captureMethod: captureMethod || "infinitepay",
                                metodoPagamento: captureMethod === "pix" ? "pix" : "cartao"
                            };
                            pedidos.unshift(novoPedidoPago);
                            updatedOrder = novoPedidoPago;
                            PENDING_INFINITEPAY_ORDERS.delete(order_nsu);
                            await writeStoreJson("pedidos", pedidos, env, ctx);
                        }
                    }
                }

                return jsonResponse({
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
                return jsonResponse({
                    success: false,
                    paid: false,
                    error: err.message
                }, 400);
            }
        }

        // 23. InfinitePay Webhook (/api/infinitepay/webhook)
        if (pathname === "/api/infinitepay/webhook" && method === "POST") {
            try {
                const body = await request.json();
                const orderNsu = String(body.order_nsu || "").replace(/^#/, "").trim();
                const invoiceSlug = String(body.invoice_slug || body.slug || "").trim();
                const transactionNsu = String(body.transaction_nsu || "").trim();
                const captureMethod = String(body.capture_method || "infinitepay").trim();
                const receiptUrl = String(body.receipt_url || "").trim();

                if (orderNsu) {
                    const pedidos = (await readStoreJson("pedidos", "/data/pedidos.json", request, env)) || [];
                    const idx = pedidos.findIndex(p => p.id === orderNsu || p.numero === orderNsu || p.numero === `#${orderNsu}`);
                    if (idx !== -1) {
                        pedidos[idx].status = "pago";
                        pedidos[idx].pagoEm = pedidos[idx].pagoEm || new Date().toISOString();
                        if (invoiceSlug) pedidos[idx].invoiceSlug = invoiceSlug;
                        if (transactionNsu) pedidos[idx].transactionNsu = transactionNsu;
                        if (receiptUrl) pedidos[idx].receiptUrl = receiptUrl;
                        pedidos[idx].captureMethod = captureMethod;
                        pedidos[idx].metodoPagamento = captureMethod === "pix" ? "pix" : "cartao";
                        await writeStoreJson("pedidos", pedidos, env, ctx);
                        PENDING_INFINITEPAY_ORDERS.delete(orderNsu);
                    } else {
                        const pendingOrder = PENDING_INFINITEPAY_ORDERS.get(orderNsu);
                        if (pendingOrder && pendingOrder.itens) {
                            const novoPedidoPago = {
                                ...pendingOrder,
                                id: orderNsu,
                                numero: `#${orderNsu}`,
                                status: "pago",
                                pagoEm: new Date().toISOString(),
                                invoiceSlug: invoiceSlug || pendingOrder.invoiceSlug || "",
                                transactionNsu: transactionNsu || "",
                                receiptUrl: receiptUrl || "",
                                captureMethod,
                                metodoPagamento: captureMethod === "pix" ? "pix" : "cartao"
                            };
                            pedidos.unshift(novoPedidoPago);
                            await writeStoreJson("pedidos", pedidos, env, ctx);
                            PENDING_INFINITEPAY_ORDERS.delete(orderNsu);
                        }
                    }
                }

                return jsonResponse({
                    success: true,
                    received: true,
                    order_nsu: orderNsu || null
                });
            } catch (err) {
                return jsonResponse({ success: false, error: err.message }, 400);
            }
        }

        // Fallback: Entrega arquivos estáticos (HTML, CSS, Imagens, Fontes)
        if (env && env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("Not Found", { status: 404 });
    }
};
