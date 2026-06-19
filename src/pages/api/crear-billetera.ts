import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

// 🌟 SOLUCIÓN: Agarramos tu clave (sin importar si mide 33 caracteres) y la convertimos en un Buffer de 32 bytes exactos
const contrasenaRaw = import.meta.env.ENCRYPTION_KEY || '';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(String(contrasenaRaw)).digest();

function encrypt(text: string) {
  const iv = crypto.randomBytes(IV_LENGTH);
  // Pasamos el Buffer directo. Ya no fallará por longitud inválida.
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const { usuarioId } = await request.json();

    if (!usuarioId) {
      return new Response(JSON.stringify({ error: 'Falta el usuarioId' }), { status: 400 });
    }

    // CAMBIO CRUCIAL: Usar import.meta.env en lugar de process.env
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
        throw new Error("Faltan las variables de entorno de Supabase en el Servidor.");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. GENERAR WALLET WEB3 TOTALMENTE NUEVA Y ALEATORIA
    const wallet = ethers.Wallet.createRandom();
    const direccionPublica = wallet.address; // Dirección (0x...) que verá el usuario
    const llavePrivadaPlana = wallet.privateKey; // Llave privada que da control total de los fondos

    // 2. ENCRIPTAR LA LLAVE PRIVADA
    const llaveEncriptada = encrypt(llavePrivadaPlana);

    // 1. Comprobar si el perfil del usuario ya existe en Supabase
    const { data: perfilExistente, error: checkError } = await supabase
      .from('perfiles')
      .select('balance_virtual')
      .eq('id', usuarioId)
      .single();

    // 2. Si no existe, lo creamos inicialmente con balance 0.00
    if (!perfilExistente) {
      const { error: insertError } = await supabase
        .from('perfiles')
        .insert({ id: usuarioId, balance_virtual: 0.00 });
        
      if (insertError) throw insertError;
      console.log("✅ Perfil nuevo creado con éxito.");
    } else {
      console.log("ℹ️ El perfil ya existía. Conservando balance de:", perfilExistente.balance_virtual);
    }
const { data: billeteraExistente } = await supabase
  .from('billeteras_deposito')
  .select('*')
  .eq('usuario_id', usuarioId)
  .single();

if (billeteraExistente) {
  return new Response(JSON.stringify({ 
    success: true, 
    mensaje: "Billetera ya asignada", 
    billetera: billeteraExistente 
  }), { status: 200 });
}
    // 4. GUARDAR LA BILLETERA DE DEPÓSITO ASOCIADA
    const { error: walletError } = await supabase
      .from('billeteras_deposito')
      .insert([
        {
          usuario_id: usuarioId,
          direccion_publica: direccionPublica,
          llave_privada_encriptada: llaveEncriptada,
        },
      ]);

    if (walletError) throw new Error(`Error en wallet: ${walletError.message}`);

    return new Response(
      JSON.stringify({ success: true, message: 'Wallet de depósito vinculada correctamente.' }),
      { status: 200 }
    );

  } catch (error: any) {
    console.log(error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};