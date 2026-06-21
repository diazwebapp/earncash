import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import crypto from 'crypto'; // 👈 Módulo nativo de Node.js para criptografía

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || import.meta.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const RPC_URL = process.env.RPC_PROVIDER_URL || import.meta.env.RPC_PROVIDER_URL || "http://127.0.0.1:8545";
const BILLETERA_MAESTRA = process.env.BILLETERA_MAESTRA_USDT || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Clave secreta de encriptación (Debe tener exactamente 32 caracteres para AES-256)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "tu_clave_secreta_de_32_caracteres_!"; 
const IV_LENGTH = 16; // Para AES, el vector de inicialización siempre es 16 bytes

/**
 * Función para desencriptar la clave privada extraída de Supabase
 */
function desencriptarClave(textoEncriptado: string): string {
  try {
    // Si la clave no está encriptada (es decir, pegaste la de Hardhat en texto plano para pruebas),
    // la devolvemos tal cual para que no rompa tu flujo local.
    if (textoEncriptado.startsWith('0x') && textoEncriptado.length === 66) {
      return textoEncriptado;
    }

    const partes = textoEncriptado.split(':');
    const iv = Buffer.from(partes.shift()!, 'hex');
    const textoCifradoOriginal = Buffer.from(partes.join(':'), 'hex');
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(textoCifradoOriginal);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString();
  } catch (err: any) {
    throw new Error(`Fallo al desencriptar la clave privada: ${err.message}`);
  }
}

export const GET: APIRoute = async () => {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    const { data: billeteras, error: dbError } = await supabase
      .from('billeteras_deposito')
      .select('usuario_id, direccion_publica, llave_privada_encriptada'); 

    if (dbError) throw dbError;
    if (!billeteras || billeteras.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No hay billeteras para escanear." }), { status: 200 });
    }

    const detallesEscaneo = [];

    for (const wallet of billeteras) {
      const direccionNormalizada = wallet.direccion_publica;
      let balanceSimulado = 0;
      
      try {
        const balanceCrudo = await provider.getBalance(direccionNormalizada);
        balanceSimulado = parseFloat(ethers.formatUnits(balanceCrudo, 18));
      } catch (err) {
        console.error(`❌ Error consultando blockchain para ${direccionNormalizada}`);
      }

      const registro = {
        usuario_id: wallet.usuario_id,
        direccion: direccionNormalizada,
        balance_blockchain_usdt: balanceSimulado,
        acreditado: false,
        barrido_exitoso: false,
        tx_hash_barrido: null as string | null,
        error: null as string | null
      };

      if (balanceSimulado > 0) {
        try {
          const { data: perfil } = await supabase
            .from('perfiles')
            .select('balance_virtual')
            .eq('id', wallet.usuario_id)
            .single();

          const nuevoBalanceVirtual = (perfil?.balance_virtual || 0) + balanceSimulado;

          // 👈 AQUÍ SE DESENCRIPTA AUTOMÁTICAMENTE LA LLAVE EXTRAÍDA
          const clavePrivadaLimpia = desencriptarClave(wallet.private_key);

          // Inicializamos el firmante con la clave segura en memoria
          const walletFirmante = new ethers.Wallet(clavePrivadaLimpia, provider);
          
          const balanceCrudo = await provider.getBalance(direccionNormalizada);
          const gasPrice = await provider.getFeeData().then(f => f.gasPrice || ethers.parseUnits("20", "gwei"));
          const gasLimit = 21000n; 
          const costoGas = gasPrice * gasLimit;

          if (balanceCrudo <= costoGas) {
            throw new Error(`Gas insuficiente.`);
          }

          const montoAEnviar = balanceCrudo - costoGas;

          const txBarrido = await walletFirmante.sendTransaction({
            to: BILLETERA_MAESTRA,
            value: montoAEnviar,
            gasLimit: gasLimit,
            gasPrice: gasPrice
          });

          const reciboTx = await txBarrido.wait();

          if (reciboTx && reciboTx.status === 1) {
            await supabase
              .from('perfiles')
              .update({ balance_virtual: nuevoBalanceVirtual })
              .eq('id', wallet.usuario_id);

            await supabase
              .from('transacciones')
              .insert({
                usuario_id: wallet.usuario_id,
                tipo: 'deposito',
                monto_virtual: balanceSimulado,
                estado: 'completado',
                hash_blockchain: txBarrido.hash
              });

            registro.acreditado = true;
            registro.barrido_exitoso = true;
            registro.tx_hash_barrido = txBarrido.hash;
          }

        } catch (errorSupabase: any) {
          console.error(`❌ Error en flujo seguro para ${wallet.usuario_id}:`, errorSupabase.message);
          registro.error = errorSupabase.message;
        }
      }

      detallesEscaneo.push(registro);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Escaneo y barrido seguro finalizado.",
        resultados: detallesEscaneo 
      }), 
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("❌ Error crítico:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};