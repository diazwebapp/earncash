import crypto from 'crypto';

const pkey = "0xac0974bec39a17e36b4a6b4d238ff944bacb478cbed5efcae78d7bf4f2ff80";

const contrasenaRaw = import.meta.env.ENCRYPTION_KEY;
const ENCRYPTION_KEY = contrasenaRaw;
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

export function encrypt(text: string) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  
  // Encriptamos especificando entrada 'utf8' y salida 'hex'
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return iv.toString('hex') + ':' + encrypted;
}

export function desencriptarClave(textoEncriptado: string): string {
  try {
    if (!textoEncriptado || !textoEncriptado.includes(':')) {
      return textoEncriptado.trim();
    }

    const partes = textoEncriptado.split(':');
    const iv = Buffer.from(partes.shift()!, 'hex');
    const textoCifradoHex = partes.join(':'); // Mantenemos el string en hex
    
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    
    // Desciframos especificando entrada 'hex' y salida 'utf8'
    let decrypted = decipher.update(textoCifradoHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    let claveLimpia = decrypted.trim().replace(/['"]/g, '');

    if (!claveLimpia.startsWith('0x')) {
      claveLimpia = '0x' + claveLimpia;
    }
    
    return claveLimpia;
  } catch (err: any) {
    throw new Error(`Fallo al desencriptar la clave privada: ${err.message}`);
  }
}
