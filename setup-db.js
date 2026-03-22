import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

const sql = `
  CREATE TABLE IF NOT EXISTS enquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel VARCHAR(50) NOT NULL,
    sender VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    intent VARCHAR(100),
    urgency VARCHAR(50),
    tone VARCHAR(50),
    threat_score FLOAT,
    response TEXT,
    delivery_status VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS rag_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query TEXT NOT NULL,
    results JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

pool.query(sql).then(() => {
  console.log('✅ Tables created successfully');
  process.exit(0);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});