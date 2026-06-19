import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
// Usa el prefijo nativo de Node para asegurar que traiga el módulo correcto
import crypto from 'crypto';


// Dirección oficial del contrato inteligente de USDT en la red BNB Chain (BEP-20)
const USDT_CONTRACT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';

// ABI mínimo para interactuar con la función balanceOf (obtener saldo) y transfer (enviar fondos) de un token ERC-20
const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
];

// Nodo público de la red BNB Chain para consultar la blockchain
const RPC_URL = 'https://bsc-dataseed.binance.org/';


const ALGORITHM = 'aes-256-cbc';

// Reutilizamos el mismo Hash SHA-256 para garantizar consistencia con el backend de creación
const contrasenaRaw = import.meta.env.ENCRYPTION_KEY || '';
const ENCRYPTION_KEY_BUFFER = crypto.createHash('sha256').update(String(contrasenaRaw)).digest();

function decrypt(text: string) {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift()!, 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY_BUFFER, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}


export const GET: APIRoute = async ({ request }) => {
  try {
    // 1. Validar Token de Seguridad del Cron Job (Para evitar que curiosos ejecuten el script)
    const url = new URL(request.url);
    const cronToken = url.searchParams.get('token');
    
    // Puedes cambiar 'mi_token_secreto_123' por la frase que desees en tu producción
    if (cronToken !== 'mi_token_secreto_123') {
      return new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401 });
    }

    // 2. Inicializar Supabase en el Servidor
    const supabaseUrl = import.meta.env.SUPABASE_URL || import.meta.env.PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
    const btcMaestra = import.meta.env.BILLETERA_MAESTRA_USDT; // Tu billetera personal de recaudación

    if (!supabaseUrl || !supabaseServiceKey || !btcMaestra) {
      throw new Error("Faltan variables de entorno cruciales.");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const usdtContrato = new ethers.Contract(USDT_CONTRACT_ADDRESS, ERC20_ABI, provider);

    // 3. Obtener todas las billeteras de depósito asignadas
    const { data: billeteras, error: dbError } = await supabase
      .from('billeteras_deposito')
      .select('usuario_id, direccion_publica');

    if (dbError || !billeteras) throw dbError || new Error("No hay billeteras.");

    let depositosProcesados = 0;

    // 4. Recorrer cada dirección y chequear si tiene saldo USDT
    for (const wallet of billeteras) {
      const saldoRaw = await usdtContrato.balanceOf(wallet.direccion_publica);
      // Convertir de formato de 18 decimales (Wei) a formato legible de USDT
      const saldoUSDT = parseFloat(ethers.formatUnits(saldoRaw, 18));

      // Si el saldo es mayor a 0, detectamos un depósito sin procesar
      if (saldoUSDT > 0) {
        console.log(`💰 ¡Depósito detectado! Usuario: ${wallet.usuario_id} envió ${saldoUSDT} USDT`);

        // A) Extraer y descifrar la llave privada de este usuario para mover sus fondos
        const { data: btcData, error: btcError } = await supabase
          .from('billeteras_deposito')
          .select('llave_privada_encriptada')
          .eq('usuario_id', wallet.usuario_id)
          .single();

        if (btcError || !btcData) {
          console.error(`No se pudo obtener la llave privada para el usuario ${wallet.usuario_id}`);
          continue;
        }

        const pkDescifrada = decrypt(btcData.llave_privada_encriptada);

        // B) Conectar la billetera del usuario a la Blockchain usando Ethers
        const walletSigner = new ethers.Wallet(pkDescifrada, provider);
        const contratoConSigner = new ethers.Contract(USDT_CONTRACT_ADDRESS, ERC20_ABI, walletSigner);

        try {
          // NOTA DE INFRAESTRUCTURA: Para transferir USDT (Token BEP-20) por la red, la billetera temporal 
          // necesita una mínima fracción de BNB nativo para pagar la comisión de gas (Network Fee).
          // En producción, tu backend debe enviarle ~$0.05 en BNB a la wallet antes de ejecutar este barrido.
          
          console.log(`Ejecutando transferencia de ${saldoRaw} hacia la billetera maestra...`);
          // Enviamos TODO el saldo USDT acumulado a tu billetera de recaudación central
          const tx = await contratoConSigner.transfer(btcMaestra, saldoRaw);
          await tx.wait(); // Esperamos que la red confirme la transacción cripto
          
          console.log(`✅ Transferencia blockchain exitosa. Hash: ${tx.hash}`);

          // C) Incrementar el balance del usuario en Supabase (Usa RPC o consulta directa)
          // Primero leemos su saldo actual
          const { data: perfil } = await supabase
            .from('perfiles')
            .select('balance_virtual')
            .eq('id', wallet.usuario_id)
            .single();

          const saldoActual = parseFloat(perfil?.balance_virtual || "0");
          const nuevoSaldo = saldoActual + saldoUSDT;

          await supabase
            .from('perfiles')
            .update({ balance_virtual: nuevoSaldo })
            .eq('id', wallet.usuario_id);

          // D) Registrar la transacción histórica para auditoría interna del usuario
          await supabase
            .from('transacciones')
            .insert({
              usuario_id: wallet.usuario_id,
              monto: saldoUSDT,
              tipo: 'deposito',
              estado: 'completado',
              tx_hash: tx.hash
            });

          depositosProcesados++;

        } catch (blockchainError: any) {
          console.error(`❌ Falló el envío de fondos en la blockchain para ${wallet.direccion_publica}:`, blockchainError.message);
          // Si falla por falta de gas (BNB), el saldo se queda seguro en su dirección pública hasta el próximo ciclo.
        }
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      mensaje: `Escaneo completado. Depósitos encontrados: ${depositosProcesados}` 
    }), { status: 200 });

  } catch (error: any) {
    console.error("❌ Error en el escuchador de depósitos:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};