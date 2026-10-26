const DEFAULT_API_KEY = "inchk_jOkw1-v4xAqj0kkbPXhWs0BwIJ503mT5SwD9q2-6AuI";
const DEFAULT_HANDLE = "sandro-cavalli";

function buildInfinitePayPayload(body, origin) {
    const handle = String(body.handle || DEFAULT_HANDLE).replace(/^\$/, '').trim() || DEFAULT_HANDLE;
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

    // Adiciona o frete como item se houver valor > 0 e ainda não estiver incluso nos items
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
    if (cli && cli.nome || (cli && cli.name)) {
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
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key"
        }
    });
}

export async function onRequestPost(context) {
    const corsHeaders = {
        "Content-Type": "application/json; charset=UTF-8",
        "Access-Control-Allow-Origin": "*"
    };

    try {
        const body = await context.request.json();
        const apiKey = (context.env && context.env.INFINITEPAY_API_KEY) || body.apiKey || DEFAULT_API_KEY;
        const reqUrl = new URL(context.request.url);
        const origin = `${reqUrl.protocol}//${reqUrl.host}`;

        const fullPayload = buildInfinitePayPayload(body, origin);
        if (!fullPayload.items || fullPayload.items.length === 0) {
            return new Response(JSON.stringify({
                success: false,
                error: "O pedido precisa conter ao menos 1 item com valor válido."
            }), { status: 400, headers: corsHeaders });
        }

        const headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Api-Key": apiKey
        };

        const endpoints = [
            "https://api.checkout.infinitepay.io/links",
            "https://api.infinitepay.io/invoices/public/checkout/links"
        ];

        let lastError = null;

        for (const endpoint of endpoints) {
            // 1ª tentativa: payload completo (com customer e address)
            try {
                const res = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(fullPayload)
                });
                const data = await res.json().catch(() => null);
                const checkoutUrl = data && (data.url || data.checkout_url || data.link);
                if (res.ok && checkoutUrl) {
                    return new Response(JSON.stringify({
                        success: true,
                        url: checkoutUrl,
                        slug: data.slug || data.invoice_slug || "",
                        order_nsu: fullPayload.order_nsu,
                        endpoint
                    }), { status: 200, headers: corsHeaders });
                }

                // 2ª tentativa no mesmo endpoint: payload enxuto sem customer/address caso validação falhe
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
                    return new Response(JSON.stringify({
                        success: true,
                        url: checkoutUrlMin,
                        slug: dataMin.slug || dataMin.invoice_slug || "",
                        order_nsu: fullPayload.order_nsu,
                        endpoint
                    }), { status: 200, headers: corsHeaders });
                }

                lastError = (data && (data.message || data.error)) || (dataMin && (dataMin.message || dataMin.error)) || `HTTP ${res.status}`;
            } catch (err) {
                lastError = err.message;
            }
        }

        return new Response(JSON.stringify({
            success: false,
            error: lastError || "Não foi possível gerar o link na API da InfinitePay."
        }), { status: 502, headers: corsHeaders });
    } catch (err) {
        return new Response(JSON.stringify({
            success: false,
            error: err.message || "Erro interno ao processar checkout InfinitePay."
        }), { status: 400, headers: corsHeaders });
    }
}

