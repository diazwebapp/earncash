import type { APIRoute } from 'astro';
import { encrypt, desencriptarClave } from '../../libs/encript';
const pkey ="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
export const GET: APIRoute = async () => {
  try {
    const llaveEncriptada = encrypt(pkey);
    const clavePrivadaLimpia = desencriptarClave(llaveEncriptada);
    return new Response(JSON.stringify({
      success: true,
      mensaje: "¡Usa este string exacto en Supabase para evitar bad decrypt!",
      clave_semilla:pkey,
      string_para_supabase: llaveEncriptada,
      clave_privada_limpia: clavePrivadaLimpia
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};