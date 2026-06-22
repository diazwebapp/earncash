import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';

// ABI mínimo necesario para llamar a la función transfer de tu contrato USDT
const USDT_ABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "to", "type": "address" },
      { "internalType": "uint256", "name": "value", "type": "uint256" }
    ],
    "name": "transfer",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

export const POST: APIRoute = async ({ request }) => {
  try {
    const { usuarioId, address, amount } = await request.json();

    if (!usuarioId || !address || !amount || amount <= 0) {
      return new Response(JSON.stringify({ error: 'Datos de retiro inválidos.' }), { status: 400 });
    }

    // Inicializar Supabase con privilegios de Servidor
    const supabaseUrl = import.meta.env.SUPABASE_URL || import.meta.env.PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Obtener el balance actual del usuario desde Supabase
    const { data: perfil, error: perfilError } = await supabase
      .from('perfiles')
      .select('balance_virtual')
      .eq('id', usuarioId)
      .single();

    if (perfilError || !perfil) {
      return new Response(JSON.stringify({ error: 'Usuario no encontrado.' }), { status: 404 });
    }

    const balanceActual = parseFloat(perfil.balance_virtual || "0");

    // 2. Verificar si tiene fondos suficientes en la base de datos
    if (balanceActual < amount) {
      return new Response(JSON.stringify({ error: 'Saldo insuficiente para realizar el retiro.' }), { status: 400 });
    }

    // ========================================================
    // ⛓️ TRANSFERENCIA EN BLOCKCHAIN (WALLET MAESTRA -> USUARIO)
    // ========================================================
    
    // Obtenemos la private key de la Wallet Maestra (la cuenta 0x3c44... de tu Hardhat)
    const privateKey = import.meta.env.MASTER_WALLET_PRIVATE_KEY as `0x${string}`;
    const accountMaster = privateKeyToAccount(privateKey);
    const RPC_URL = process.env.RPC_PROVIDER_URL || import.meta.env.RPC_PROVIDER_URL ;
    // Creamos el cliente de Viem apuntando a tu nodo local de Hardhat
    const walletClient = createWalletClient({
      account: accountMaster,
      chain: hardhat,
      transport: http(RPC_URL), 
    }).extend(publicActions);

    // Convertimos el monto a Wei (18 decimales)
    const montoWei = BigInt(Math.floor(amount)) * BigInt(10 ** 18);

    console.log(`🚀 Transfiriendo ${amount} USDT en Blockchain a la dirección ${address}...`);

    // Ejecutamos la transferencia interactuando con tu contrato simulado de USDT
    const txHash = await walletClient.writeContract({
      address: import.meta.env.USDT_CONTRACT_ADDRESS as `0x${string}`,
      abi: USDT_ABI,
      functionName: 'transfer',
      args: [address as `0x${string}`, montoWei],
    });

    // Esperamos a que el nodo local de Hardhat procese el bloque
    await walletClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`✅ Transacción confirmada en Hardhat. Hash: ${txHash}`);

    // ========================================================
    // 💾 ACTUALIZACIÓN DE SALDOS EN SUPABASE
    // ========================================================

    // 3. Restar el saldo en la tabla 'perfiles'
    const nuevoSaldo = balanceActual - amount;
    const { error: updateError } = await supabase
      .from('perfiles')
      .update({ balance_virtual: nuevoSaldo })
      .eq('id', usuarioId);

    if (updateError) throw updateError;

    // 4. Registrar la transacción como COMPLETADA guardando el hash real
    const { error: txError } = await supabase
      .from('transacciones')
      .insert({
        usuario_id: usuarioId,
        monto_virtual: amount,
        tipo: 'retiro',
        estado: 'completado', // Ya no queda pendiente, se liquida de inmediato
        hash_blockchain: txHash, 
      });

    if (txError) throw txError;

    return new Response(JSON.stringify({ success: true, nuevoSaldo, txHash }), { status: 200 });

  } catch (error: any) {
    console.error("❌ Error en solicitud de retiro:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};