import nodemailer from 'nodemailer';
import config from '../config/index.js';

class EmailService {
  constructor() {
    this.transporter = null;
    this._init();
  }

  _init() {
    const { host, port, secure, user, pass } = config.smtp;

    if (!user || !pass) {
      console.warn('[EmailService] SMTP_USER or SMTP_PASS not set – emails will not be sent.');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure, // false for port 587 (STARTTLS)
      auth: { user, pass },
    });

    // Verify connection on startup
    this.transporter.verify()
      .then(() => console.log('[EmailService] SMTP connection verified ✓'))
      .catch((err) => console.error('[EmailService] SMTP connection failed:', err.message));
  }

  /**
   * Send an email.
   * @param {{ to: string, subject: string, body: string, cc?: string, bcc?: string }} options
   * @returns {Promise<{ messageId: string }>}
   */
  async sendEmail({ to, subject, body, cc, bcc }) {
    if (!this.transporter) {
      throw new Error('Email service not configured – check SMTP_USER and SMTP_PASS env vars.');
    }

    const mailOptions = {
      from: `"${config.smtp.fromName}" <${config.smtp.user}>`,
      to,
      subject,
      html: body, // email templates contain HTML
      ...(cc && { cc }),
      ...(bcc && { bcc }),
    };

    const info = await this.transporter.sendMail(mailOptions);
    console.log(`[EmailService] Email sent to ${to} – messageId: ${info.messageId}`);
    return { messageId: info.messageId };
  }
}

// Singleton instance
const emailService = new EmailService();
export default emailService;
