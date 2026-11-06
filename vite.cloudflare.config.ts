import vinext from "vinext";
import {defineConfig} from "vite";
import {cloudflare} from "@cloudflare/vite-plugin";
import {sites} from "./build/sites-vite-plugin";

// Independent Cloudflare account deployment. The existing Sites config is retained.
export default defineConfig({
 plugins:[
  vinext(),
  sites({mockAuth:false}),
  cloudflare({configPath:"wrangler.cloudflare.jsonc",viteEnvironment:{name:"rsc",childEnvironments:["ssr"]},inspectorPort:false}),
 ],
});
