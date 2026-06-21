import type { APIRoute } from 'astro';
import CryptoJS from 'crypto-js';
const key = "12345678901234567890123456789012"; // Tu clave del .env
const pkey = "0xac0974bec39a17e36b4a6b4d238ff944bacb478cbed5efcae78d7bf4f2ff80";
const stringNuevo = CryptoJS.AES.encrypt(pkey, key).toString();
console.log("Pega esto en Supabase:", stringNuevo);
export const GET: APIRoute = async () => {
  try {

    return new Response(JSON.stringify({
      success: true,
      mensaje: "¡Usa este string exacto en Supabase para evitar bad decrypt!",
      string_para_supabase: stringNuevo
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};