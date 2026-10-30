import nodemailer from "nodemailer";
import svgCaptcha from "svg-captcha";
import { ApiError } from "./api";
import type { EmailAuthServices } from "./email-auth";

export function emailAuthServices(bindings: Record<string, unknown>): EmailAuthServices {
  const sender = bindings.SMTP_SENDER, code = bindings.SMTP_AUTH_CODE;
  if (bindings.ZAOSHI_RUNTIME !== "node" || typeof sender !== "string" || !/^[a-zA-Z0-9._-]+@163\.com$/u.test(sender) || typeof code !== "string" || code.length < 16) {
    throw new ApiError(503, "EMAIL_AUTH_NOT_CONFIGURED", "邮箱登录尚未配置，请联系管理员。");
  }
  return {
    captcha: (answer) => (svgCaptcha as unknown as (text: string, options: Record<string, unknown>) => string)(answer, { noise: 3, color: true, background: "#f2f4f7", width: 180, height: 60, fontSize: 48 }),
    async send(email, answer) {
      const transport = nodemailer.createTransport({ host: "smtp.163.com", port: 465, secure: true, auth: { user: sender, pass: code }, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000, logger: false, debug: false });
      try { await transport.sendMail({ from: sender, to: email, subject: "造室邮箱验证码", text: `你的造室邮箱验证码为 ${answer}，10分钟内有效。如非本人操作，请忽略此邮件。` }); }
      finally { transport.close(); }
    },
  };
}
