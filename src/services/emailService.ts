/**
 * Email Service — sends verification codes and transactional emails.
 *
 * Uses Resend (HTTP API) — works on HF Spaces, Render, Railway, etc.
 * Falls back to console logging in dev mode if not configured.
 *
 * Requires: RESEND_API_KEY env var.
 */

export interface EmailServiceConfig {
  resendApiKey?: string;
  fromEmail?: string;
  fromName?: string;
  isDev?: boolean;
}

export class EmailService {
  private readonly apiKey: string | null;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly isDev: boolean;

  constructor(config: EmailServiceConfig) {
    this.apiKey = config.resendApiKey || null;
    this.fromEmail = config.fromEmail || 'noreply@afrai.dev';
    this.fromName = config.fromName || 'AfrAI';
    this.isDev = config.isDev || false;
  }

  /**
   * Send a 6-digit verification code email.
   */
  async sendVerificationCode(toEmail: string, code: string, name?: string): Promise<boolean> {
    const displayName = name || 'there';

    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1 style="color: #0066FF; font-size: 28px; margin: 0;">🌍 AfrAI</h1>
        <p style="color: #888; font-size: 14px; margin-top: 4px;">AI Infrastructure for Africa</p>
      </div>
      <div style="background: #f0f6ff; border-radius: 16px; padding: 32px; text-align: center;">
        <h2 style="color: #1a1a2e; margin: 0 0 8px;">Hey ${displayName}! 👋</h2>
        <p style="color: #555; font-size: 15px; margin: 0 0 24px;">Enter this code to verify your email:</p>
        <div style="background: #0066FF; color: white; font-size: 36px; font-weight: 800; letter-spacing: 12px; padding: 20px 32px; border-radius: 12px; display: inline-block; font-family: monospace;">
          ${code}
        </div>
        <p style="color: #888; font-size: 13px; margin-top: 24px;">This code expires in 10 minutes.</p>
      </div>
      <p style="color: #999; font-size: 12px; text-align: center; margin-top: 24px;">
        If you didn't sign up for AfrAI, you can safely ignore this email.
      </p>
    </div>`;

    const text = `Your AfrAI verification code is: ${code}\nIt expires in 10 minutes.`;

    return this.send(toEmail, `🌍 Your AfrAI Verification Code: ${code}`, html, text);
  }

  /**
   * Send a welcome email after successful registration.
   */
  async sendWelcomeEmail(toEmail: string, name: string, keyPrefix: string): Promise<boolean> {
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1 style="color: #0066FF; font-size: 28px; margin: 0;">🌍 AfrAI</h1>
      </div>
      <div style="background: #f0f6ff; border-radius: 16px; padding: 32px;">
        <h2 style="color: #1a1a2e; margin: 0 0 12px;">Welcome to AfrAI, ${name}! 🎉</h2>
        <p style="color: #555; font-size: 15px;">Your account is verified and your API key (starting with <code>${keyPrefix}...</code>) is active.</p>
        <p style="color: #555; font-size: 15px;">You now have access to:</p>
        <ul style="color: #555; font-size: 14px;">
          <li>Smart model routing across OpenAI, Anthropic, Google, Groq & more</li>
          <li>60 requests per minute (free tier)</li>
          <li>Automatic provider fallback</li>
          <li>Mobile Money top-ups</li>
        </ul>
        <p style="color: #555; font-size: 15px;">Get started: <a href="https://afrai.vercel.app/docs" style="color: #0066FF;">View API Docs →</a></p>
      </div>
      <p style="color: #999; font-size: 12px; text-align: center; margin-top: 24px;">
        Built in Ghana 🇬🇭 by Alpha Global Minds
      </p>
    </div>`;

    const text = `Welcome to AfrAI, ${name}! Your account is verified and your API key is active. Get started at https://afrai.vercel.app/docs`;

    return this.send(toEmail, `Welcome to AfrAI, ${name}! 🌍`, html, text);
  }

  /**
   * Send email via Resend HTTP API. Falls back to console in dev mode.
   */
  private async send(to: string, subject: string, html: string, text: string): Promise<boolean> {
    if (!this.apiKey) {
      if (this.isDev) {
        console.log(`📧 [DEV EMAIL] To: ${to} | Subject: ${subject}`);
        console.log(`📧 [DEV EMAIL] Text: ${text}`);
        return true;
      }
      console.error('Email service not configured — set RESEND_API_KEY');
      return false;
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${this.fromName} <${this.fromEmail}>`,
          to: [to],
          subject,
          html,
          text,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`Resend API error (${res.status}):`, err);
        return false;
      }

      return true;
    } catch (err) {
      console.error('Email send failed:', err);
      return false;
    }
  }

  /** Check if email sending is available */
  get isConfigured(): boolean {
    return this.apiKey !== null || this.isDev;
  }
}
