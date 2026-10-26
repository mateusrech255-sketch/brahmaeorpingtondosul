export async function onRequestPost(context) {
    const headers = {
        "Content-Type": "application/json; charset=UTF-8",
        "Access-Control-Allow-Origin": "*"
    };
    try {
        const body = await context.request.json();
        return new Response(JSON.stringify({
            success: true,
            received: true,
            order_nsu: body.order_nsu || null,
            invoice_slug: body.invoice_slug || null,
            transaction_nsu: body.transaction_nsu || null
        }), { status: 200, headers });
    } catch (err) {
        return new Response(JSON.stringify({
            success: false,
            error: err.message
        }), { status: 400, headers });
    }
}

