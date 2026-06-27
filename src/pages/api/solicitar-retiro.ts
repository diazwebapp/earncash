import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL ;
const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY ;

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Llave privada maestra para firmar los retiros automáticos desde el backend seguro
const PRIVATE_KEY_MAESTRA = import.meta.env.MASTER_WALLET_PRIVATE_KEY || process.env.MASTER_WALLET_PRIVATE_KEY ;

export const POST: APIRoute = async ({ request }) => {
  try {
    // 1. Recibimos los parámetros desde el frontend (incluyendo la red seleccionada)
    const { usuarioId, address, amount, redSlug } = await request.json();

    if (!usuarioId || !address || !amount || amount <= 0 || !redSlug) {
      return new Response(JSON.stringify({ error: 'Datos de retiro inválidos.' }), { status: 400 });
    }

    // 2. Traemos el perfil del usuario para validar su saldo virtual
    const { data: perfil, error: perfilError } = await supabase
      .from('perfiles')
      .select('balance_virtual')
      .eq('id', usuarioId)
      .single();

    if (perfilError || !perfil) {
      return new Response(JSON.stringify({ error: 'Usuario no encontrado.' }), { status: 404 });
    }

    const balanceActual = parseFloat(perfil.balance_virtual || "0");
    if (balanceActual < amount) {
      return new Response(JSON.stringify({ error: 'Saldo insuficiente para realizar el retiro.' }), { status: 400 });
    }

    // 3. Traemos la configuración global (Automático vs Manual)
    const { data: config } = await supabase
      .from('retiros_automaticos')
      .select('retiros_automaticos')
      .eq('id', 1)
      .single();

    const esAutomatico = config?.retiros_automaticos ?? true;

    // 4. Obtener los detalles de la blockchain seleccionada desde redes_config
    const { data: redData, error: redError } = await supabase
      .from('redes_config')
      .select('*')
      .eq('slug', redSlug)
      .single();

    if (redError || !redData) {
      return new Response(JSON.stringify({ error: 'La red seleccionada no está configurada.' }), { status: 400 });
    }

    // 5. VALIDACIÓN SENSACIONAL: ¿La billetera destino pertenece a un usuario de nuestra plataforma?
    const { data: walletInterna } = await supabase
      .from('billeteras_deposito')
      .select('usuario_id')
      .eq('direccion_publica', address.toLowerCase())
      .maybeSingle();

    // ========================================================
    // CASO A: ES UNA TRANSFERENCIA INTERNA (ENTRE NUESTROS USUARIOS)
    // ========================================================
    if (walletInterna) {
      console.log(`🔄 Transferencia interna detectada. Moviendo saldos en Supabase de ${usuarioId} hacia ${walletInterna.usuario_id}`);

      // Descontamos al emisor
      const nuevoSaldoEmisor = balanceActual - amount;
      await supabase.from('perfiles').update({ balance_virtual: nuevoSaldoEmisor }).eq('id', usuarioId);

      // Traemos y sumamos al receptor interno
      const { data: perfilReceptor } = await supabase
        .from('perfiles')
        .select('balance_virtual')
        .eq('id', walletInterna.usuario_id)
        .single();
      
      const nuevoSaldoReceptor = parseFloat(perfilReceptor?.balance_virtual || "0") + amount;
      await supabase.from('perfiles').update({ balance_virtual: nuevoSaldoReceptor }).eq('id', walletInterna.usuario_id);

      // Registramos la transacción completada de inmediato (Sin gas, sin blockchain)
      const { data: tx } = await supabase.from('transacciones').insert({
        usuario_id: usuarioId,
        monto_virtual: amount,
        tipo: 'retiro',
        estado: 'completado',
        hash_blockchain: 'INTERNAL_TRANSFER'
      }).select().single();

      return new Response(JSON.stringify({ 
        success: true, 
        message: "Transferencia interna procesada al instante sin comisiones de red.", 
        nuevoSaldo: nuevoSaldoEmisor,
        txId: tx?.id
      }), { status: 200 });
    }

    // ========================================================
    // CASO B: TRANSFERENCIA EXTERNA A BLOCKCHAIN REAL
    // ========================================================
    
    // Descontamos preventivamente el saldo del usuario para evitar ataques de doble gasto
    const nuevoSaldo = balanceActual - amount;
    await supabase.from('perfiles').update({ balance_virtual: nuevoSaldo }).eq('id', usuarioId);

    if (esAutomatico) {
      const erc20Abi = [
          "function transfer(address to, uint256 value) returns (bool)"
        ];
      try {
        console.log(`⛓️ Ejecutando Retiro Automático de ${amount} USDT en la red ${redData.nombre}...`);

        const provider = new ethers.JsonRpcProvider(redData.rpc_url.replace(/["']/g, ""));
        const walletMaster = new ethers.Wallet(PRIVATE_KEY_MAESTRA, provider);

        const contratoUSDT = new ethers.Contract(
          redData.usdt_contrato.replace(/["']/g, ""), 
          erc20Abi, 
          walletMaster
        );

        // Parseamos el monto usando los decimales de la tabla (6 o 18)
        const montoWei = ethers.parseUnits(amount.toString(), redData.decimales);
        const feeData = await provider.getFeeData();

        // Enviamos la transacción real a la blockchain usando el nodo de Alchemy
        const tx = await contratoUSDT.transfer(address, montoWei, {
          gasLimit: 65000,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
        });

        const recibo = await tx.wait();

        if (recibo && recibo.status === 1) {
          await supabase.from('transacciones').insert({
            usuario_id: usuarioId,
            monto_virtual: amount,
            tipo: 'retiro',
            estado: 'completado',
            hash_blockchain: tx.hash
          });

          return new Response(JSON.stringify({ success: true, nuevoSaldo, txHash: tx.hash }), { status: 200 });
        } else {
          throw new Error("La transacción falló en la blockchain.");
        }

      } catch (blockchainError: any) {
        console.error("❌ Error en retiro automático. Revirtiendo saldo y guardando como pendiente:", blockchainError.message);
        
        // Si el automático falla (ejemplo: te quedaste sin gas para pagar el envío), revertimos el saldo y lo dejamos en pendiente
        await supabase.from('perfiles').update({ balance_virtual: balanceActual }).eq('id', usuarioId);
        
        await supabase.from('transacciones').insert({
          usuario_id: usuarioId,
          monto_virtual: amount,
          tipo: 'retiro',
          estado: 'pendiente',
          hash_blockchain: null
        });

        return new Response(JSON.stringify({ 
          success: true, 
          message: "El retiro automático falló por gas o red, pero se guardó de forma segura como PENDIENTE para procesamiento manual.",
          nuevoSaldo: balanceActual
        }), { status: 200 });
      }

    } else {
      // MODO MANUAL: Simplemente guardamos la orden en estado "pendiente"
      console.log("💼 Modo manual activo. Registrando transacción pendiente.");
      
      await supabase.from('transacciones').insert({
        usuario_id: usuarioId,
        monto_virtual: amount,
        tipo: 'retiro',
        estado: 'pendiente',
        hash_blockchain: null
      });

      return new Response(JSON.stringify({ 
        success: true, 
        message: "Retiro registrado de forma exitosa. Se procesará manualmente por administración.", 
        nuevoSaldo 
      }), { status: 200 });
    }

  } catch (error: any) {
    console.error("❌ Error crítico en el endpoint de retiros:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};