'use strict';
// Every email the portal sends, in one place.
// Account emails (VINC ID, approval, KYC, investments, certificates) always go out.
// Update emails (news, documents, share price, founder replies) respect the member's "email me about updates" setting.
const { db, getSettings } = require('./db');
const mail = require('./mailer');

const first = (u) => ((u && u.name) || '').trim().split(/\s+/)[0] || 'there';
const fmtDate = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST';
const money = (n) => { const c = getSettings().currency || '₹'; return c + Number(n).toLocaleString(c === '₹' ? 'en-IN' : 'en-US', { maximumFractionDigits: 2 }); };
const founder = () => { const n = getSettings().founder_name; return n && n !== 'the Founder' ? n : 'the founder'; };
const company = () => getSettings().company_name || 'VINC';

// Members whose access is live right now and who want update emails.
function activeRecipients(onlyUserId) {
  const rows = db.prepare(`SELECT * FROM users WHERE role != 'admin' AND status = 'active' AND email IS NOT NULL AND email != ''
                           AND email_updates = 1 AND (access_type = 'permanent' OR access_expires_at > ?)`).all(Date.now());
  return onlyUserId ? rows.filter((u) => u.id === onlyUserId) : rows;
}
const toAdmin = (msg) => mail.ADMIN_EMAIL && mail.send({ to: mail.ADMIN_EMAIL, ...msg, footer: 'Admin notification from VINC Global.' });

// ---------------------------------------------------------------- account emails
function invitation(u) {
  return mail.send({
    to: u.email, kind: 'invite', subject: `Your VINC ID: ${u.uid}`,
    title: 'Welcome to VINC Global',
    greeting: `Hello ${first(u)},`,
    lines: [`You have been invited to VINC Global, the private portal for the ${u.role === 'investor' ? 'investors' : 'advisors'} who back ${company()}.`,
      'Use your VINC ID below to sign up and choose a password. The team will then open the doors for you.'],
    facts: [['Your VINC ID', u.uid], ['Role', u.role === 'investor' ? 'Investor' : 'Advisor']],
    button: { text: 'Activate my VINC ID', path: `/signup?uid=${encodeURIComponent(u.uid)}` },
  });
}

function loginReady(u) {
  return mail.send({
    to: u.email, kind: 'invite', subject: `Your VINC Global login: ${u.uid}`,
    title: 'Your VINC Global login is ready',
    greeting: `Hello ${first(u)},`,
    lines: ['The VINC team has set up your account. Log in with the VINC ID below and the password the team shared with you separately, then change it under Account.'],
    facts: [['Your VINC ID', u.uid]],
    button: { text: 'Log in', path: '/login' },
  });
}

function approved(u) {
  const temp = u.access_type === 'temporary';
  const hours = temp ? Math.round((u.access_expires_at - u.approved_at) / 3600000) : null;
  return mail.send({
    to: u.email, kind: 'approved', subject: temp ? `You're in: ${hours}-hour access to VINC Global` : "You're in: permanent access to VINC Global",
    title: temp ? 'Your preview window is open' : 'Welcome to the VINC circle',
    greeting: `Hello ${first(u)},`,
    lines: temp
      ? [`The VINC team has approved a ${hours}-hour preview for you. Look around the data room, follow your investment and ask the founder anything.`,
        'When the window closes you can ask for access again from the portal.']
      : ['The VINC team has given you permanent access to VINC Global. The data room, your investment and a direct line to the founder are all waiting for you.'],
    facts: temp ? [['Access until', fmtDate(u.access_expires_at)], ['VINC ID', u.uid]] : [['Access', 'Permanent'], ['VINC ID', u.uid]],
    button: { text: 'Log in to VINC Global', path: '/login' },
  });
}

function kycReviewed(u, k) {
  const ok = k.status === 'verified';
  return mail.send({
    to: u.email, kind: 'kyc', subject: ok ? `KYC verified: ${k.doc_type}` : `KYC: please upload a new ${k.doc_type}`,
    title: ok ? 'Document verified' : 'We need a new copy',
    greeting: `Hello ${first(u)},`,
    lines: [ok ? `Your ${k.doc_type} has been verified. Thank you.` : `We could not verify your ${k.doc_type}. Please upload a new copy from the KYC page.`],
    quote: !ok && k.remark ? k.remark : null,
    button: { text: 'Open KYC documents', path: '/advisor#kyc' },
  });
}

function investmentRecorded(u, inv) {
  return mail.send({
    to: u.email, kind: 'investment', subject: 'Your investment has been recorded',
    title: 'Investment recorded',
    greeting: `Hello ${first(u)},`,
    lines: [`Thank you for investing in ${company()}. Your investment now shows in VINC Global.`],
    facts: [['Date', inv.invested_on], ['Amount', money(inv.amount)], ['Shares', Number(inv.shares).toLocaleString('en-IN')], ...(inv.round ? [['Round', inv.round]] : [])],
    button: { text: 'See my investment', path: '/advisor#portfolio' },
  });
}

function certificateIssued(u, c) {
  return mail.send({
    to: u.email, kind: 'certificate', subject: 'Your share certificate is ready',
    title: 'Share certificate issued',
    greeting: `Hello ${first(u)},`,
    lines: ['Your share certificate is ready to view and download in VINC Global.'],
    facts: [['Certificate', c.title], ...(c.certificate_no ? [['Number', c.certificate_no]] : [])],
    button: { text: 'Download my certificate', path: '/advisor#portfolio' },
  });
}

// ---------------------------------------------------------------- update emails
function newsPublished(n) {
  for (const u of activeRecipients()) {
    mail.send({
      to: u.email, kind: 'news', subject: `VINC update: ${n.title}`,
      title: n.title, greeting: `Hello ${first(u)},`,
      lines: n.body.split(/\n{2,}/).slice(0, 6),
      button: { text: 'Read in VINC Global', path: '/advisor#news' },
      footer: 'You get these because you are a VINC Global member. Turn off update emails under Account in the portal.',
    });
  }
}

function documentPublished(d) {
  const label = { pdf: 'document', excel: 'spreadsheet', link: 'link' }[d.kind] || 'document';
  for (const u of activeRecipients(d.audience_user_id || null)) {
    mail.send({
      to: u.email, kind: 'document', subject: `New in the data room: ${d.title}`,
      title: 'New in the data room', greeting: `Hello ${first(u)},`,
      lines: [`A new ${label} has been shared with you${d.audience_user_id ? ' personally' : ''}: "${d.title}".`, ...(d.description ? [d.description] : []),
        'It opens in view-only mode inside the portal.'],
      button: { text: 'Open the data room', path: '/advisor#vault' },
      footer: 'You get these because you are a VINC Global member. Turn off update emails under Account in the portal.',
    });
  }
}

function priceUpdated(p) {
  // Only when this is the newest actual price (back-filling history sends nothing).
  const latest = db.prepare("SELECT on_date FROM share_prices WHERE kind = 'actual' ORDER BY on_date DESC, id DESC LIMIT 1").get();
  if (!latest || latest.on_date !== p.on_date) return;
  for (const u of activeRecipients()) {
    mail.send({
      to: u.email, kind: 'price', subject: `New ${company()} share price: ${money(p.price)}`,
      title: 'The share price has been updated', greeting: `Hello ${first(u)},`,
      lines: ['The company has published a new share price. Your holding has been revalued in the portal.'],
      facts: [['Price per share', money(p.price)], ['As of', p.on_date], ...(p.note ? [['Note', p.note]] : [])],
      button: { text: 'See my investment', path: '/advisor#portfolio' },
      footer: 'You get these because you are a VINC Global member. Turn off update emails under Account in the portal.',
    });
  }
}

// At most one "the founder replied" email per member every 15 minutes.
const lastChatMail = new Map();
function founderReplied(userId, body) {
  const now = Date.now();
  if ((lastChatMail.get(userId) || 0) > now - 15 * 60000) return;
  const [u] = activeRecipients(userId);
  if (!u) return;
  lastChatMail.set(userId, now);
  mail.send({
    to: u.email, kind: 'chat', subject: `${founder() === 'the founder' ? 'The founder' : founder()} replied to you on VINC Global`,
    title: 'You have a reply', greeting: `Hello ${first(u)},`,
    lines: [`${founder() === 'the founder' ? 'The founder' : founder()} answered in Ask the Founder:`],
    quote: body.length > 600 ? body.slice(0, 600) + '…' : body,
    button: { text: 'Open the conversation', path: '/advisor' },
    footer: 'You get these because you are a VINC Global member. Turn off update emails under Account in the portal.',
  });
}

// ---------------------------------------------------------------- admin notifications
function adminSignup(u, renewal) {
  toAdmin({
    kind: 'admin', subject: renewal ? `${u.name || u.uid} asked for access again` : `New sign-up waiting for approval: ${u.name || u.uid}`,
    title: renewal ? 'Renewal request' : 'New sign-up', replyTo: u.email || undefined,
    lines: [renewal ? 'Their preview window has closed and they would like to continue.' : 'They have activated their VINC ID and are waiting for approval.'],
    facts: [['Name', u.name || '—'], ['VINC ID', u.uid], ['Email', u.email || '—'], ...(u.phone ? [['Phone', u.phone]] : []), ...(u.organisation ? [['Organisation', u.organisation]] : [])],
    button: { text: 'Review approvals', path: '/admin#approvals' },
  });
}

const lastAdminChat = new Map();
function adminNewMessage(u, body) {
  const now = Date.now();
  if ((lastAdminChat.get(u.id) || 0) > now - 10 * 60000) return;
  lastAdminChat.set(u.id, now);
  toAdmin({
    kind: 'admin', subject: `New question from ${u.name || u.uid}`, title: 'Ask the Founder', replyTo: u.email || undefined,
    lines: [`${u.name || u.uid} (${u.uid}) asked:`], quote: body.length > 600 ? body.slice(0, 600) + '…' : body,
    button: { text: 'Answer in Founder Q&A', path: `/admin#chats/${u.id}` },
  });
}

function adminKycUploaded(u, type) {
  toAdmin({ kind: 'admin', subject: `KYC to review: ${type} from ${u.name || u.uid}`, title: 'KYC document uploaded',
    facts: [['Member', `${u.name || '—'} (${u.uid})`], ['Document', type]], button: { text: 'Review KYC', path: '/admin#kyc' } });
}

function idRequested(r) {
  toAdmin({
    kind: 'admin', subject: `VINC ID request from ${r.name}`, title: 'Someone asked for a VINC ID', replyTo: r.email,
    facts: [['Name', r.name], ['Email', r.email], ...(r.phone ? [['Phone', r.phone]] : []), ...(r.organisation ? [['Organisation', r.organisation]] : []), ['Interested as', r.role === 'investor' ? 'Investor' : 'Advisor']],
    quote: r.message || null,
    button: { text: 'Review ID requests', path: '/admin#requests' },
  });
  mail.send({
    to: r.email, kind: 'request', subject: 'We received your VINC ID request',
    title: 'Thank you for your interest in VINC', greeting: `Hello ${first(r)},`,
    lines: ['We have received your request for a VINC ID. The team will review it and, once approved, email you your personal VINC ID with a link to sign up.'],
    footer: 'You are receiving this because you asked for a VINC ID on vinc-global.com.',
  });
}

module.exports = {
  invitation, loginReady, approved, kycReviewed, investmentRecorded, certificateIssued,
  newsPublished, documentPublished, priceUpdated, founderReplied,
  adminSignup, adminNewMessage, adminKycUploaded, idRequested,
};
