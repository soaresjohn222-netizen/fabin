import { createClient } from "@supabase/supabase-js";

export interface SupabaseSettings {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_ADMIN_EMAIL?: string;
  SUPABASE_ADMIN_ID?: string;
  SUPABASE_STORAGE_BUCKET?: string;
}
function client(url:string,key:string) {
  if(!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url))throw new Error("Invalid Supabase URL");
  return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}});
}
export function authSettings(settings:SupabaseSettings) {
  const {SUPABASE_URL:url,SUPABASE_PUBLISHABLE_KEY:key,SUPABASE_ADMIN_EMAIL:email,SUPABASE_ADMIN_ID:id}=settings;
  if(!url||!key||!email||!id)throw new Error("Supabase Auth is not configured");
  return {url,key,email,id};
}
export async function verifySupabasePassword(settings:SupabaseSettings,password:string) {
  const {url,key,email,id}=authSettings(settings);
  const auth=client(url,key).auth;
  const {data,error}=await auth.signInWithPassword({email,password});
  if(error){if(error.status===400||error.status===401||error.status===422)return false;throw new Error("Authentication provider unavailable");}
  const valid=data.user?.id===id&&!!data.session;
  // The application issues its own revocable HttpOnly session. Never send provider tokens to the browser.
  if(data.session)await auth.signOut({scope:"local"});
  return valid;
}
type PutOptions={httpMetadata?:{contentType?:string};customMetadata?:Record<string,string>};
export function supabaseBucket(settings:SupabaseSettings) {
  const {SUPABASE_URL:url,SUPABASE_SECRET_KEY:key,SUPABASE_STORAGE_BUCKET:name}=settings;
  if(!url||!key||!name)throw new Error("Supabase Storage is not configured");
  const storage=client(url,key).storage.from(name);
  function path(key:string){if(!/^(originals|manifests)\/[a-zA-Z0-9_/-]+$/.test(key)||key.includes(".."))throw new Error("Invalid object path");return key;}
  function missing(error:{statusCode?:string|number}){return String(error.statusCode)==="404";}
  return {
    async get(key:string){
      const {data,error}=await storage.download(path(key));
      if(error){if(missing(error))return null;throw new Error("Storage download failed");}
      return {body:data.stream(),text:()=>data.text()};
    },
    async put(key:string,value:string|Uint8Array,options:PutOptions={}){
      const {error}=await storage.upload(path(key),value,{upsert:true,contentType:options.httpMetadata?.contentType||"application/octet-stream",metadata:options.customMetadata});
      if(error)throw new Error("Storage upload failed");
    },
    async head(key:string){
      const {data,error}=await storage.info(path(key));
      if(error){if(missing(error))return null;throw new Error("Storage metadata failed");}
      const info=data as unknown as {userMetadata?:Record<string,string>;metadata?:Record<string,string>};
      return {customMetadata:info.userMetadata||info.metadata||{}};
    },
    async delete(key:string){const {error}=await storage.remove([path(key)]);if(error)throw new Error("Storage deletion failed");},
  };
}
