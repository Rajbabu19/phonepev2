import express from 'express';
import cors from 'cors';
import {
    StandardCheckoutClient,
    Env,
    MetaInfo,
    StandardCheckoutPayRequest,
    PhonePeException
} from 'pg-sdk-node';
import { randomUUID } from 'crypto';
import 'dotenv/config';

// --- 1. SDK और एनवायरनमेंट वेरिएबल्स ---

const CLIENT_ID = process.env.PHONEPE_CLIENT_ID;
const CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const CLIENT_VERSION = process.env.PHONEPE_CLIENT_VERSION;
// यह .env फ़ाइल से 'PRODUCTION' पढ़ेगा जब आप लाइव होंगे
const ENV = (process.env.PHONEPE_ENV === 'PRODUCTION') ? Env.PRODUCTION : Env.SANDBOX;

// वेबहुक के लिए (यह आप PhonePe डैशबोर्ड में सेट करते हैं)
const WEBHOOK_USERNAME = process.env.WEBHOOK_USERNAME;
const WEBHOOK_PASSWORD = process.env.WEBHOOK_PASSWORD;

let client;
try {
    client = StandardCheckoutClient.getInstance(CLIENT_ID, CLIENT_SECRET, CLIENT_VERSION, ENV);
    console.log(`PhonePe Client Initialized in ${ENV} mode.`);
} catch (error) {
    console.error("Error initializing PhonePe Client:", error.message);
    process.exit(1);
}

// --- 2. EXPRESS सर्वर सेटअप ---

const app = express();
const PORT = process.env.PORT || 3000;

// CORS इनेबल करें
app.use(cors()); 

// पेमेंट एंडपॉइंट के लिए JSON पार्सर
// ध्यान दें: हम इसे /webhook रूट पर इस्तेमाल नहीं करेंगे
app.use(express.json({ limit: '10mb' }));

// --- 3. पेमेंट API एंडपॉइंट ---
// (यह वही है जो आपके पास पहले था)
app.post('/api/phonepe/pay', async (req, res) => {
    try {
        const { orderData, returnUrl } = req.body;
        if (!orderData || !returnUrl) {
            return res.status(400).json({ success: false, message: "Invalid request body." });
        }
        
        const { amount, customer_details, product_name } = orderData;
        const amountInPaisa = Math.round(amount) * 100;
        const merchantOrderId = `MUID-${randomUUID().substring(0, 8)}`;

        const metaInfo = MetaInfo.builder()
            .udf1(product_name.substring(0, 255))
            .udf2(customer_details.customer_name)
            .build();

        const request = StandardCheckoutPayRequest.builder()
            .merchantOrderId(merchantOrderId)
            .amount(amountInPaisa)
            .redirectUrl(returnUrl) 
            .metaInfo(metaInfo)
            .build();

        console.log(`Initiating payment for ${merchantOrderId} with amount ${amountInPaisa} PAISE`);
        const response = await client.pay(request);
        console.log("PhonePe Pay API Response:", response);
        
        res.json(response);

    } catch (error) {
        handleException(error, res);
    }
});

// --- 4. वेबहुक हैंडलर एंडपॉइंट (नया) ---

// यह रूट वेबहुक के लिए है।
// हमें PhonePe से रॉ बॉडी (raw body) चाहिए, इसलिए हम express.json() के बजाय express.raw() का उपयोग करते हैं।
app.post(
    '/api/phonepe/webhook',
    express.raw({ type: 'application/json', limit: '10mb' }), // रॉ बॉडी पार्सर
    async (req, res) => {
        
        console.log("Received webhook from PhonePe...");

        try {
            const authorizationHeader = req.headers['authorization'];
            // req.body अब एक बफ़र (Buffer) है, इसे स्ट्रिंग में बदलें
            const responseBodyString = req.body.toString();

            if (!authorizationHeader) {
                console.warn("Webhook received without Authorization header.");
                return res.status(401).send("Unauthorized");
            }

            // वेबहुक को वैलिडेट करें
            const callbackResponse = client.validateCallback(
                WEBHOOK_USERNAME,
                WEBHOOK_PASSWORD,
                authorizationHeader,
                responseBodyString
            );

            // वैलिडेशन सफल
            console.log("Webhook validation successful.");
            console.log("Payload:", JSON.stringify(callbackResponse.payload, null, 2));

            const payload = callbackResponse.payload;
            const eventType = callbackResponse.type;

            // --- !!! यहाँ अपना डेटाबेस अपडेट करें !!! ---
            // पेमेंट सफल होने पर अपने डेटाबेस को अपडेट करने के लिए इस लॉजिक का उपयोग करें।
            // यह 'thank you' पेज से ज़्यादा भरोसेमंद है।

            if (eventType === 'CHECKOUT_ORDER_COMPLETED') {
                if (payload.state === 'COMPLETED') {
                    console.log(`SUCCESS: Order ${payload.originalMerchantOrderId} COMPLETED.`);
                    // उदा. await database.updateOrder(payload.originalMerchantOrderId, 'PAID');
                } else if (payload.state === 'FAILED') {
                    console.log(`FAILED: Order ${payload.originalMerchantOrderId} FAILED.`);
                    // उदा. await database.updateOrder(payload.originalMerchantOrderId, 'FAILED');
                }
            } else if (eventType.startsWith('PG_REFUND')) {
                // रिफंड लॉजिक
                console.log(`REFUND Event: ${eventType} for ${payload.merchantRefundId}`);
            }
            // --- डेटाबेस लॉजिक समाप्त ---

            // PhonePe को 200 OK भेजकर बताएँ कि वेबहुक मिल गया
            res.status(200).json({ success: true, message: "Webhook processed." });

        } catch (error) {
            console.error("Webhook validation failed or processing error:", error.message);
            if (error instanceof PhonePeException) {
                res.status(401).json({ success: false, message: error.message });
            } else {
                res.status(500).json({ success: false, message: "Internal server error." });
            }
        }
    }
);


// --- 5. एरर हैंडलर ---

function handleException(error, res) {
    if (error instanceof PhonePeException) {
        console.error('PhonePeException:', {
            message: error.message,
            code: error.code,
            httpStatusCode: error.httpStatusCode,
            data: error.data
        });
        res.status(error.httpStatusCode || 500).json({
            success: false,
            message: error.message,
            code: error.code
        });
    } else {
        console.error('Generic Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'An unexpected error occurred.',
            error: error.message
        });
    }
}

// --- 6. सर्वर स्टार्ट करें ---

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});