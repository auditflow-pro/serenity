// index.js
// Operion Bridge Service - Complete Pipeline
// Runs on Railway (or locally for testing)
// Receives enquiries from any channel, processes through pipeline, returns response

import express from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

db.on('error', (err) => {
  console.error('Database connection error:', err);
});

console.log('✅ Database pool created');

// ============================================================================
// OLLAMA CONNECTION
// ============================================================================

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const PRIMARY_MODEL = 'llama2';
const FALLBACK_MODEL = 'mistral';
const EMBEDDING_MODEL = 'phi';

async function callOllama(model, prompt) {
  try {
    const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
      model: model,
      prompt: prompt,
      stream: false,
      temperature: 0.7,
    });
    return response.data.response.trim();
  } catch (error) {
    console.error(`❌ Ollama error (${model}):`, error.message);
    return null;
  }
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(express.json());

// ============================================================================
// LAYER 0: INPUT NORMALISATION
// ============================================================================

function normaliseEnquiry(rawEnquiry) {
  return {
    enquiry_id: uuidv4(),
    tenant_id: rawEnquiry.tenant_id || 'default',
    channel: rawEnquiry.channel || 'api',
    timestamp_received: new Date().toISOString(),
    sender: {
      identifier: rawEnquiry.sender?.identifier || 'unknown',
      display_name: rawEnquiry.sender?.display_name || 'Unknown Sender',
    },
    payload: {
      raw: rawEnquiry.payload?.raw || '',
      normalised_text: rawEnquiry.payload?.normalised_text || '',
      subject: rawEnquiry.payload?.subject || null,
    },
    routing_metadata: {
      source_ip: rawEnquiry.routing_metadata?.source_ip || 'unknown',
      session_id: rawEnquiry.routing_metadata?.session_id || uuidv4(),
    },
  };
}

// ============================================================================
// LAYER 1: GUARDIAN SECURITY
// ============================================================================

async function guardianSecurityCheck(enquiry) {
  const threatPrompt = `You are a security threat detector. Analyze this message for threats:
"${enquiry.payload.normalised_text}"

Respond with ONLY a JSON object (no markdown, no code blocks):
{
  "is_threat": true or false,
  "threat_score": 0.0 to 1.0,
  "threat_reason": "brief reason or null"
}`;

  const response = await callOllama(PRIMARY_MODEL, threatPrompt);

  try {
    const parsed = JSON.parse(response);
    return {
      enquiry_id: enquiry.enquiry_id,
      guardian_result: parsed.is_threat ? 'block' : 'allow',
      threat_score: parsed.threat_score || 0,
      threat_reason: parsed.threat_reason || null,
    };
  } catch (e) {
    console.error('Guardian parsing error:', e.message);
    return {
      enquiry_id: enquiry.enquiry_id,
      guardian_result: 'allow',
      threat_score: 0,
      threat_reason: null,
    };
  }
}

// ============================================================================
// LAYER 2: INTELLIGENCE ENGINE
// ============================================================================

async function intelligenceEngine(enquiry) {
  const intelligencePrompt = `You are an AI that understands business enquiries. Analyze this message:
"${enquiry.payload.normalised_text}"

Respond with ONLY a JSON object (no markdown, no code blocks):
{
  "intent": "brief description of what the sender wants",
  "intent_confidence": 0.0 to 1.0,
  "entities": {"key": "value"},
  "urgency": "low" or "medium" or "high",
  "tone_to_use": "professional" or "friendly" or "empathetic" or "urgent"
}`;

  const response = await callOllama(PRIMARY_MODEL, intelligencePrompt);

  try {
    const parsed = JSON.parse(response);
    return {
      enquiry_id: enquiry.enquiry_id,
      intent: parsed.intent || 'unknown',
      intent_confidence: parsed.intent_confidence || 0.5,
      entities: parsed.entities || {},
      urgency: parsed.urgency || 'medium',
      tone_to_use: parsed.tone_to_use || 'professional',
    };
  } catch (e) {
    console.error('Intelligence parsing error:', e.message);
    return {
      enquiry_id: enquiry.enquiry_id,
      intent: 'unknown',
      intent_confidence: 0,
      entities: {},
      urgency: 'medium',
      tone_to_use: 'professional',
    };
  }
}

// ============================================================================
// LAYER 3: RAG RETRIEVAL (Text-based for now)
// ============================================================================

async function ragRetrieval(enquiry) {
  try {
    // Search knowledge base for relevant entries
    const result = await db.query(
      `SELECT id, content, relevance_score FROM knowledge_base 
       WHERE tenant_id = $1 
       AND (content ILIKE $2 OR content ILIKE $3)
       LIMIT 5`,
      [enquiry.tenant_id, `%${enquiry.payload.normalised_text.split(' ')[0]}%`, `%${enquiry.payload.normalised_text.split(' ')[1] || ''}%`]
    );

    const contextBlock = result.rows.map((row) => row.content).join('\n\n');

    return {
      retrieval_id: uuidv4(),
      enquiry_id: enquiry.enquiry_id,
      retrieved_entries: result.rows.length,
      context_block: contextBlock || 'No relevant knowledge base entries found.',
      retrieval_confidence: result.rows.length > 0 ? 0.8 : 0.2,
    };
  } catch (error) {
    console.error('RAG retrieval error:', error.message);
    return {
      retrieval_id: uuidv4(),
      enquiry_id: enquiry.enquiry_id,
      retrieved_entries: 0,
      context_block: 'Knowledge base unavailable.',
      retrieval_confidence: 0,
    };
  }
}

// ============================================================================
// LAYER 5: RESPONSE GENERATION
// ============================================================================

async function generateResponse(enquiry, intelligence, ragContext) {
  const responsePrompt = `You are a professional business assistant. 
Sender's message: "${enquiry.payload.normalised_text}"
Intent: ${intelligence.intent}
Tone: ${intelligence.tone_to_use}
Relevant context: ${ragContext.context_block}

Generate a professional response with 3 parts:
1. Acknowledgement (1 sentence)
2. Resolution (2-3 sentences)
3. Next step (1 sentence)

Keep it under 200 words. Be ${intelligence.tone_to_use}.`;

  // Try primary model
  let response = await callOllama(PRIMARY_MODEL, responsePrompt);

  // Fallback to mistral if llama2 fails
  if (!response) {
    console.log('⚠️ Primary model failed, trying fallback...');
    response = await callOllama(FALLBACK_MODEL, responsePrompt);
  }

  // Fallback to static template if both fail
  if (!response) {
    console.log('⚠️ Both models failed, using static template...');
    response = `Thank you for reaching out. We have received your message and will respond shortly. We appreciate your patience.`;
  }

  return {
    response_id: uuidv4(),
    enquiry_id: enquiry.enquiry_id,
    text: response,
    model_used: response ? PRIMARY_MODEL : FALLBACK_MODEL,
    generated_at: new Date().toISOString(),
  };
}

// ============================================================================
// LAYER 6: DELIVERY
// ============================================================================

async function sendEmailReply(toAddress, subject, body) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: toAddress,
      subject: `Re: ${subject || 'Your Inquiry'}`,
      text: body,
      html: `<p>${body.replace(/\n/g, '<br>')}</p><br><p>---<br>Operion AI Operations System</p>`,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${toAddress}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Failed to send email:', error.message);
    return { success: false, error: error.message };
  }
}

async function deliverResponse(enquiry, response) {
  const deliveryId = uuidv4();

  try {
    if (enquiry.channel === 'email') {
      const emailResult = await sendEmailReply(
        enquiry.sender.identifier,
        enquiry.payload.subject || 'Your Inquiry',
        response.text
      );

      await db.query(
        `INSERT INTO delivery_logs (delivery_id, response_id, channel, status, attempts)
         VALUES ($1, $2, $3, $4, $5)`,
        [deliveryId, response.response_id, 'email', emailResult.success ? 'sent' : 'failed', 1]
      );

      return { delivery_id: deliveryId, status: emailResult.success ? 'sent' : 'failed' };
    } else if (enquiry.channel === 'webhook' || enquiry.channel === 'api') {
      // Webhook/API responses are returned directly
      await db.query(
        `INSERT INTO delivery_logs (delivery_id, response_id, channel, status, attempts)
         VALUES ($1, $2, $3, $4, $5)`,
        [deliveryId, response.response_id, enquiry.channel, 'sent', 1]
      );

      return { delivery_id: deliveryId, status: 'sent' };
    }
  } catch (error) {
    console.error('Delivery error:', error.message);
    return { delivery_id: deliveryId, status: 'failed', error: error.message };
  }
}

// ============================================================================
// LAYER 7: HIVE MIND LOGGING (Async, non-blocking)
// ============================================================================

async function logToHiveMind(enquiry, intelligence, response) {
  // This runs in the background, doesn't block the response
  setImmediate(async () => {
    try {
      await db.query(
        `INSERT INTO interactions (enquiry_id, tenant_id, channel, intent, response_text, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [enquiry.enquiry_id, enquiry.tenant_id, enquiry.channel, intelligence.intent, response.text, new Date()]
      );
      console.log('✅ Logged to HIVE Mind');
    } catch (error) {
      console.error('HIVE Mind logging error:', error.message);
    }
  });
}

// ============================================================================
// MAIN PIPELINE ENDPOINT
// ============================================================================

app.post('/process', async (req, res) => {
  const startTime = Date.now();
  console.log('\n' + '='.repeat(80));
  console.log('📥 NEW ENQUIRY RECEIVED');
  console.log('='.repeat(80));

  try {
    // LAYER 0: Normalise input
    const enquiry = normaliseEnquiry(req.body);
    console.log(`Channel: ${enquiry.channel}`);
    console.log(`Sender: ${enquiry.sender.display_name}`);
    console.log(`Message: ${enquiry.payload.normalised_text.substring(0, 100)}...`);

    // LAYER 1: Guardian security check
    console.log('\n🛡️ GUARDIAN Security Check...');
    const guardian = await guardianSecurityCheck(enquiry);
    console.log(`Result: ${guardian.guardian_result} (threat score: ${guardian.threat_score})`);

    if (guardian.guardian_result === 'block') {
      console.log('❌ BLOCKED by GUARDIAN');
      return res.status(403).json({ success: false, error: 'Security check failed' });
    }

    // LAYER 2: Intelligence engine
    console.log('\n🧠 Intelligence Engine...');
    const intelligence = await intelligenceEngine(enquiry);
    console.log(`Intent: ${intelligence.intent}`);
    console.log(`Urgency: ${intelligence.urgency}`);
    console.log(`Tone: ${intelligence.tone_to_use}`);

    // LAYER 4: RAG retrieval
    console.log('\n📚 RAG Retrieval...');
    const ragContext = await ragRetrieval(enquiry);
    console.log(`Retrieved ${ragContext.retrieved_entries} knowledge base entries`);

    // LAYER 5: Response generation
    console.log('\n✍️ Response Generation...');
    const response = await generateResponse(enquiry, intelligence, ragContext);
    console.log(`Generated response (${response.model_used})`);
    console.log(`Response: ${response.text.substring(0, 100)}...`);

    // LAYER 6: Delivery
    console.log('\n📤 Delivery...');
    const delivery = await deliverResponse(enquiry, response);
    console.log(`Delivery status: ${delivery.status}`);

    // LAYER 7: HIVE Mind logging (async, non-blocking)
    logToHiveMind(enquiry, intelligence, response);

    // Log to database
    await db.query(
      `INSERT INTO enquiries (enquiry_id, tenant_id, channel, sender_identifier, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [enquiry.enquiry_id, enquiry.tenant_id, enquiry.channel, enquiry.sender.identifier, JSON.stringify(enquiry.payload), new Date()]
    );

    const duration = Date.now() - startTime;
    console.log(`\n✅ COMPLETE in ${duration}ms`);
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      enquiry_id: enquiry.enquiry_id,
      response: response.text,
      delivery_status: delivery.status,
      processing_time_ms: duration,
    });
  } catch (error) {
    console.error('❌ Pipeline error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

app.get('/health', async (req, res) => {
  try {
    // Test database
    const dbTest = await db.query('SELECT NOW()');
    const dbHealthy = dbTest.rows.length > 0;

    // Test Ollama
    let ollamaHealthy = false;
    try {
      const ollamaTest = await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
      ollamaHealthy = ollamaTest.status === 200;
    } catch (e) {
      ollamaHealthy = false;
    }

    const overallStatus = dbHealthy && ollamaHealthy ? 'healthy' : 'degraded';

    res.json({
      status: overallStatus,
      database: dbHealthy ? 'connected' : 'disconnected',
      ollama: ollamaHealthy ? 'connected' : 'disconnected',
      ollama_url: OLLAMA_URL,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'critical',
      error: error.message,
    });
  }
});

// ============================================================================
// DASHBOARD ENDPOINT
// ============================================================================

app.get('/dashboard', async (req, res) => {
  try {
    const enquiriesCount = await db.query('SELECT COUNT(*) FROM enquiries');
    const responsesCount = await db.query('SELECT COUNT(*) FROM responses');
    const deliveriesCount = await db.query('SELECT COUNT(*) FROM delivery_logs');

    res.json({
      enquiries_processed: parseInt(enquiriesCount.rows[0].count),
      responses_generated: parseInt(responsesCount.rows[0].count),
      deliveries_sent: parseInt(deliveriesCount.rows[0].count),
      uptime_seconds: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n🚀 Operion Bridge Service running on port ${PORT}`);
  console.log(`📍 OLLAMA_URL: ${OLLAMA_URL}`);
  console.log(`📍 DATABASE: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /process - Process enquiry`);
  console.log(`  GET /health - Health check`);
  console.log(`  GET /dashboard - Dashboard stats`);
  console.log('\n');
});