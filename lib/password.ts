import { scryptSync, timingSafeEqual, createHash, randomBytes } from "node:crypto";
// scrypt: 32 MiB of memory, three passes; never store or log a plaintext password.
export function hashPassword(password:string) {
  const salt=randomBytes(24).toString("hex");
  const key=scryptSync(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString("hex");
  return `scrypt$32768$8$3$${salt}$${key}`;
}
export function verifyPassword(password:string,encoded:string) {
  const [algorithm,n,r,p,salt,key]=encoded.split("$");
  if(algorithm!=="scrypt"||n!=="32768"||r!=="8"||p!=="3"||!salt||!key||key.length!==128)throw new Error("Invalid password configuration");
  const derived=scryptSync(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024});
  return timingSafeEqual(derived,Buffer.from(key,"hex"));
}
export const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
export const token=()=>randomBytes(32).toString("hex");
