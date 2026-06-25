import type { APIRoute } from 'astro';
import { encrypt, desencriptarClave } from '../../libs/encript';
const pkey ="0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
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