import type { APIRoute } from 'astro';
import { createPublicClient, http, parseAbi } from 'viem';
import { hardhat } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
const contratoUsdtAddress = import.meta.env.USDT_CONTRACT_ADDRESS;
const rpcUrl = import.meta.env.RPC_PROVIDER_URL;

// Wallet maestra de la plataforma
const WALLET_MAESTRA_SISTEMA = import.meta.env.BILLETERA_MAESTRA_USDT.toLowerCase();

const supabase = createClient(supabaseUrl || '', supabaseServiceKey || '');
const clientePublico = createPublicClient({
  chain: hardhat,
  transport: http(rpcUrl),
});

const abiEventoTransferencia = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)'
]);

export const GET: APIRoute = async () => {
  console.log("\n📡 [Escuchador] Procesando conciliación de transferencias...");

  if (!clientePublico) {
    return new Response(JSON.stringify({ success: false, error: "Cliente RPC no listo." }), { status: 500 });
  }

  const bloqueActual = await clientePublico.getBlockNumber();
  const registros = await clientePublico.getContractEvents({
    address: contratoUsdtAddress as `0x${string}`,
    abi: abiEventoTransferencia,
    eventName: 'Transfer',
    fromBlock: 0n,
    toBlock: bloqueActual,
  });

  let depositosNuevos = 0;
  let retirosConfirmados = 0;
  let txOmitidas = 0;
  const detallesProcesados = [];

  for (const registro of registros) {
    const { from, to, value } = registro.args;
    if (!from || !to || !value) continue;

    const txHash = registro.transactionHash.toLowerCase();
    const montoUSDT = Number(value) / 10 ** 18;
    const walletEmisor = from.toLowerCase();
    const walletDestino = to.toLowerCase();

    // 1. ESCENARIO DE RETIROS (Sale de la Wallet Maestra)
    if (walletEmisor === WALLET_MAESTRA_SISTEMA) {
      const { data: retiroPendiente } = await supabase
        .from('transacciones')
        .select('id, estado')
        .eq('hash_blockchain', txHash)
        .maybeSingle();

      if (retiroPendiente) {
        if (retiroPendiente.estado === 'pendiente') {
          // Confirmamos el retiro cambiando el estado a completado
          await supabase.from('transacciones').update({ estado: 'completado' }).eq('id', retiroPendiente.id);
          
          retirosConfirmados++;
          
          // 🔥 LA CLAVE: ¿La dirección que recibió el retiro es una wallet del sistema?
          const { data: receptorMatch } = await supabase
            .from('billeteras_deposito')
            .select(`usuario_id, perfiles ( id, balance_virtual )`)
            .ilike('direccion_publica', walletDestino)
            .maybeSingle();

          if (receptorMatch && receptorMatch.perfiles) {
            const perfilDestino = receptorMatch.perfiles as unknown as { id: string; balance_virtual: string | number };
            const balanceActualDestino = parseFloat(String(perfilDestino.balance_virtual || "0"));
            const nuevoBalanceDestino = balanceActualDestino + montoUSDT;

            // Incrementamos el balance contable del Perfil Receptor
            await supabase
              .from('perfiles')
              .update({ balance_virtual: nuevoBalanceDestino })
              .eq('id', perfilDestino.id);

            detallesProcesados.push({
              tx_hash: txHash,
              tipo: "retiro_confirmado_y_abonado_a_destino",
              monto: montoUSDT,
              usuario_receptor_id: perfilDestino.id,
              nuevo_balance_receptor: nuevoBalanceDestino
            });
            continue;
          }

          detallesProcesados.push({
            tx_hash: txHash,
            tipo: "retiro_confirmado_externo",
            monto: montoUSDT,
            estado: "cambiado_a_completado"
          });
        } else {
          txOmitidas++;
        }
      }
      continue;
    }

    // 2. IDEMPOTENCIA GENERAL PARA DEPÓSITOS DIRECTOS
    const { data: txExistente } = await supabase
      .from('transacciones')
      .select('id')
      .eq('hash_blockchain', txHash)
      .maybeSingle();

    if (txExistente) {
      txOmitidas++;
      continue;
    }

    // 3. ESCENARIO DE DEPÓSITOS DIRECTOS (Alguien transfiere externamente a una wallet de la plataforma)
    const { data: depositoMatch } = await supabase
      .from('billeteras_deposito')
      .select(`usuario_id, perfiles ( id, balance_virtual )`)
      .ilike('direccion_publica', walletDestino)
      .maybeSingle();

    if (depositoMatch && depositoMatch.perfiles) {
      const perfil = depositoMatch.perfiles as unknown as { id: string; balance_virtual: string | number };
      const balanceActual = parseFloat(String(perfil.balance_virtual || "0"));
      const nuevoBalance = balanceActual + montoUSDT;

      const { error: errorInsertDep } = await supabase.from('transacciones').insert({
        usuario_id: perfil.id,
        monto_virtual: montoUSDT,
        hash_blockchain: txHash,
        tipo: 'deposito',
        estado: 'completado'
      });

      if (errorInsertDep) continue;

      await supabase.from('perfiles').update({ balance_virtual: nuevoBalance }).eq('id', perfil.id);

      depositosNuevos++;
      detallesProcesados.push({
        tx_hash: txHash,
        tipo: "deposito_acreditado",
        usuario_id: perfil.id,
        monto: montoUSDT,
        nuevo_saldo: nuevoBalance
      });
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      bloque_sincronizado: bloqueActual.toString(),
      total_eventos_analizados: registros.length,
      nuevos_depositos_acreditados: depositosNuevos,
      retiros_confirmados_onchain: retirosConfirmados,
      transacciones_omitidas: txOmitidas,
      historial_procesados: detallesProcesados
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};