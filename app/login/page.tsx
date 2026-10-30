import { EmailAuthView } from "@/components/auth/EmailAuthView";
import { readWechatAuthConfig, validateWechatAuthConfig } from "@/lib/server/wechat-auth-config";
export default function LoginPage() { return <EmailAuthView wechatReady={validateWechatAuthConfig(readWechatAuthConfig())} />; }
