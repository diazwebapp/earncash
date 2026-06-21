import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || import.meta.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const RPC_URL = process.env.RPC_PROVIDER_URL || import.meta.env.RPC_PROVIDER_URL || "http://127.0.0.1:8545";
// Cambia esto por tu dirección personal o la de la cuenta de recaudación principal
const BILLETERA_MAESTRA = process.env.BILLETERA_MAESTRA_USDT || "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

// Mapeo temporal de Claves Privadas de Hardhat vinculadas a las direcciones públicas de tus usuarios
// NOTA: Reemplaza estas direcciones con las que tienes asignadas actualmente en tu Supabase
const CLAVES_PRIVADAS_LOCALES: Record<string, string> = {
  // Billetera #0 de tu consola Hardhat (Mapeada de forma matemáticamente correcta)
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", 
  
  // Billetera #1 de tu consola Hardhat
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8": "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
};

export const GET: APIRoute = async () => {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    const { data: billeteras, error: dbError } = await supabase
      .from('billeteras_deposito')
      .select('usuario_id, direccion_publica');

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

      // Si se detectan fondos, procesamos acreditación y posterior barrido
      if (balanceSimulado > 0) {
        try {
          const { data: perfil } = await supabase
            .from('perfiles')
            .select('balance_virtual')
            .eq('id', wallet.usuario_id)
            .single();

          const nuevoBalanceVirtual = (perfil?.balance_virtual || 0) + balanceSimulado;

          // 1. Convertimos la dirección al formato Checksum oficial (con mayúsculas/minúsculas correctas)
          const direccionChecksum = ethers.getAddress(direccionNormalizada);
          const clavePrivada = CLAVES_PRIVADAS_LOCALES[direccionChecksum];

          if (!clavePrivada) {
            throw new Error(`Clave privada no encontrada en el servidor para la billetera mapeada: ${direccionChecksum}`);
          }

          // 2. Conectamos al firmante (Wallet)
          const walletFirmante = new ethers.Wallet(clavePrivada, provider);
          
          // Obtenemos el balance crudo actual directo de la blockchain
          const balanceCrudo = await provider.getBalance(direccionNormalizada);
          
          // Fijamos valores de gas estándar y económicos para el nodo de desarrollo local
          const gasPrice = await provider.getFeeData().then(f => f.gasPrice || ethers.parseUnits("20", "gwei"));
          const gasLimit = 21000n; 
          const costoGas = gasPrice * gasLimit;

          // Verificación matemática segura usando BigInt
          if (balanceCrudo <= costoGas) {
            throw new Error(`Fondos insuficientes para cubrir el gas. Balance: ${ethers.formatEther(balanceCrudo)} ETH, Gas Necesario: ${ethers.formatEther(costoGas)} ETH`);
          }

          // Restamos el costo exacto del gas para vaciar la cuenta por completo
          const montoAEnviar = balanceCrudo - costoGas;

          // 3. Ejecutamos el barrido real mandando todo el remanente neto
          const txBarrido = await walletFirmante.sendTransaction({
            to: BILLETERA_MAESTRA,
            value: montoAEnviar,
            gasLimit: gasLimit,
            gasPrice: gasPrice
          });

          // Esperamos 1 confirmación del bloque local
          const reciboTx = await txBarrido.wait();

          // 4. SOLO SI LA BLOCKCHAIN COMPLETÓ EL RETIRO, actualizamos la base de datos
          if (reciboTx && reciboTx.status === 1) {
            // A. Incrementamos el balance virtual del usuario en perfiles
            await supabase
              .from('perfiles')
              .update({ balance_virtual: nuevoBalanceVirtual })
              .eq('id', wallet.usuario_id);

            // B. Registramos en transacciones usando el hash blockchain real
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
          console.error(`❌ Error en flujo de barrido para ${wallet.usuario_id}:`, errorSupabase.message);
          registro.error = errorSupabase.message;
        }
      }

      detallesEscaneo.push(registro);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Escaneo y barrido automatizado finalizado.",
        resultados: detallesEscaneo 
      }), 
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("❌ Error crítico:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};