// email-receiver.js
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const BRIDGE_WEBHOOK_URL = process.env.BRIDGE_WEBHOOK_URL;
const PROCESSED_EMAILS_FILE = 'processed_emails.json';

let processedEmails = new Set();

function loadProcessedEmails() {
 try {
 const fs = require('fs');
 if (fs.existsSync(PROCESSED_EMAILS_FILE)) {
 const data = JSON.parse(fs.readFileSync(PROCESSED_EMAILS_FILE, 'utf8'));
 processedEmails = new Set(data);
 }
 } catch (e) {
 console.log('No processed emails file yet — starting fresh');
 }
}

function saveProcessedEmails() {
 const fs = require('fs');
 fs.writeFileSync(PROCESSED_EMAILS_FILE, JSON.stringify([...processedEmails]));
}

const imap = new Imap({
 user: GMAIL_USER,
 password: GMAIL_APP_PASSWORD,
 host: 'imap.gmail.com',
 port: 993,
 tls: true,
 tlsOptions: { rejectUnauthorized: false },
});

function openInbox(cb) {
 imap.openBox('INBOX', false, cb);
}

async function processEmail(msg, seqno) {
 return new Promise((resolve, reject) => {
 simpleParser(msg, async (err, parsed) => {
 if (err) {
 console.error('Error parsing email:', err);
 return reject(err);
 }
 try {
 const emailId = `${parsed.from.text}-${parsed.date.getTime()}`;
 if (processedEmails.has(emailId)) {
 console.log(`Skipping already-processed email from ${parsed.from.text}`);
 return resolve();
 }
 console.log(`\n📧 New email from: ${parsed.from.text}`);
 console.log(`Subject: ${parsed.subject}`);
 console.log(`Body: ${parsed.text.substring(0, 100)}...`);
 const payload = {
 channel: 'email',
 sender: {
 identifier: parsed.from.text,
 display_name: parsed.from.text,
 },
 payload: {
 raw: parsed.text,
 normalised_text: parsed.text,
 subject: parsed.subject,
 },
 routing_metadata: {
 source_ip: 'email-receiver',
 session_id: emailId,
 },
 };
 console.log(`Sending to bridge: ${BRIDGE_WEBHOOK_URL}`);
 const response = await axios.post(BRIDGE_WEBHOOK_URL, payload, {
 timeout: 30000,
 });
 console.log(`✅ Bridge responded:`, response.data);
 processedEmails.add(emailId);
 saveProcessedEmails();
 resolve();
 } catch (error) {
 console.error('Error sending to bridge:', error.message);
 reject(error);
 }
 });
 });
}

async function checkEmails() {
 return new Promise((resolve, reject) => {
 openInbox((err, box) => {
 if (err) {
 console.error('Error opening inbox:', err);
 return reject(err);
 }
 imap.search(['UNSEEN'], (err, results) => {
 if (err) {
 console.error('Error searching emails:', err);
 return reject(err);
 }
 if (results.length === 0) {
 console.log('No new emails');
 return resolve();
 }
 console.log(`Found ${results.length} new email(s)`);
 const f = imap.fetch(results, { bodies: '' });
 let processed = 0;
 f.on('message', (msg, seqno) => {
 processEmail(msg, seqno)
 .then(() => {
 processed++;
 if (processed === results.length) {
 resolve();
 }
 })
 .catch((err) => {
 console.error('Error processing email:', err);
 processed++;
 if (processed === results.length) {
 resolve();
 }
 });
 });
 f.on('error', (err) => {
 console.error('Fetch error:', err);
 reject(err);
 });
 });
 });
 });
}

imap.on('ready', () => {
 console.log('✅ Connected to Gmail');
 openInbox((err, box) => {
 if (err) {
 console.error('Failed to open inbox:', err);
 process.exit(1);
 }
 console.log('✅ Listening for emails...');
 
 // Check emails every 30 seconds
 setInterval(async () => {
 try {
 await checkEmails();
 } catch (error) {
 console.error('Error in email check loop:', error.message);
 }
 }, 30000);
 });
});

imap.on('error', (err) => {
 console.error('IMAP error:', err);
});

imap.on('end', () => {
 console.log('IMAP connection ended');
});

loadProcessedEmails();
loadProcessedEmails();