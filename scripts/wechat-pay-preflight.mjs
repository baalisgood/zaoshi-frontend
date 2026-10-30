import { lstatSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
// Metadata only: never open, decrypt, unzip, print, or upload credentials.
const required = ["WECHAT_PAY_APP_ID", "WECHAT_PAY_MCH_ID", "WECHAT_PAY_MERCHANT_SERIAL", "WECHAT_PAY_PUBLIC_KEY_ID", "WECHAT_PAY_NOTIFY_URL", "SERVICE_OPERATOR_NAME", "SERVICE_CONTACT"];
const fields = Object.fromEntries(required.map(name => [name, process.env[name]?.trim() ? "configured" : "missing"]));
const root = "/run/secrets";
for (const name of ["WECHAT_PAY_PRIVATE_KEY_FILE", "WECHAT_PAY_API_V3_KEY_FILE", "WECHAT_PAY_PUBLIC_KEY_FILE"]) {
 const value=process.env[name];
 if(!value){fields[name]="missing";continue;}
 try {
  const path=resolve(value),nested=relative(root,path);let current=root;
  if(!isAbsolute(value)||!nested||nested.startsWith(`..${sep}`)||nested===".."||isAbsolute(nested))throw Error();
  const base=lstatSync(root);if(!base.isDirectory()||base.isSymbolicLink()||(base.mode&0o022))throw Error();
  const parts=nested.split(sep);
  for(const [index,part] of parts.entries()){
   current=resolve(current,part);const stat=lstatSync(current);if(stat.isSymbolicLink())throw Error();
   if(index<parts.length-1){if(!stat.isDirectory()||(stat.mode&0o022))throw Error();}
   else if(!stat.isFile()||![0o400,0o600].includes(stat.mode&0o777)||stat.uid!==process.geteuid?.()||stat.size<1||stat.size>16384)throw Error();
  }
  fields[name]="metadata_ok_contents_not_checked";
 }catch{fields[name]="unsafe_or_unavailable";}
}
const ready=Object.values(fields).every(value=>value==="configured"||value==="metadata_ok_contents_not_checked");
console.log(JSON.stringify({scope:"metadata_only_no_payment_request",fields,configurationMetadataComplete:ready,realPaymentVerified:false},null,2));
process.exitCode=ready?0:1;
