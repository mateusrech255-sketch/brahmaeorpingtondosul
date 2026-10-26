const DEFAULT_API_KEY = "inchk_jOkw1-v4xAqj0kkbPXhWs0BwIJ503mT5SwD9q2-6AuI";
const DEFAULT_HANDLE = "sandro-cavalli";

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
        const handle = String(body.handle || DEFAULT_HANDLE).replace(/^\$/, '').trim() || DEFAULT_HANDLE;
        const order_nsu = String(body.order_nsu || body.orderId || '').replace(/^#/, '').trim();
        const transaction_nsu = String(body.transaction_nsu || '').trim();
        const slug = String(body.slug || body.invoice_slug || '').trim();

        const payload = {
            handle,
            order_nsu,
            transaction_nsu,
            slug
        };

        const headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Api-Key": apiKey
        };

        const endpoints = [
            "https://api.checkout.infinitepay.io/payment_check",
            "https://api.infinitepay.io/invoices/public/checkout/payment_check"
        ];

        for (const endpoint of endpoints) {
            try {
                const res = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(payload)
                });
                const data = await res.json().catch(() => null);
                if (res.ok && data) {
                    return new Response(JSON.stringify({
                        success: true,
                        paid: Boolean(data.paid || data.success),
                        capture_method: data.capture_method || "",
                        amount: data.amount || 0,
                        paid_amount: data.paid_amount || 0,
                        installments: data.installments || 1,
                        raw: data
                    }), { status: 200, headers: corsHeaders });
                }
            } catch (e) {}
        }

        // Se transaction_nsu e slug vieram do redirecionamento oficial da InfinitePay
        if (transaction_nsu && slug) {
            return new Response(JSON.stringify({
                success: true,
                paid: true,
                capture_method: body.capture_method || "infinitepay",
                order_nsu,
                transaction_nsu,
                slug
            }), { status: 200, headers: corsHeaders });
        }

        return new Response(JSON.stringify({
            success: false,
            paid: false,
            error: "Não foi possível confirmar o status da transação no momento."
        }), { status: 200, headers: corsHeaders });
    } catch (err) {
        return new Response(JSON.stringify({
            success: false,
            paid: false,
            error: err.message
        }), { status: 400, headers: corsHeaders });
    }
}

