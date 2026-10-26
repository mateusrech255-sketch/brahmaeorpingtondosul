const DEFAULT_API_KEY = "inchk_jOkw1-v4xAqj0kkbPXhWs0BwIJ503mT5SwD9q2-6AuI";
const DEFAULT_HANDLE = "sandro-cavalli";

export async function onRequestGet() {
    return new Response(JSON.stringify({
        success: true,
        config: {
            enabled: true,
            handle: DEFAULT_HANDLE,
            apiKey: DEFAULT_API_KEY,
            checkoutEndpoint: "https://api.checkout.infinitepay.io/links",
            paymentCheckEndpoint: "https://api.checkout.infinitepay.io/payment_check",
            docsUrl: "https://www.infinitepay.io/checkout-documentacao",
            portalUrl: "https://www.infinitepay.io/checkout"
        }
    }), {
        status: 200,
        headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "Access-Control-Allow-Origin": "*"
        }
    });
}

