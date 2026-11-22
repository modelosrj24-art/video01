import type { GatewayId, PaymentProvider } from './types.ts';
import { MercadoPagoProvider } from './providers/mercadopago.ts';
import { PayPalProvider } from './providers/paypal.ts';

const providers = new Map<GatewayId, PaymentProvider>();

export function registerPaymentProvider(provider: PaymentProvider) {
  providers.set(provider.gatewayId, provider);
}

registerPaymentProvider(new MercadoPagoProvider());
registerPaymentProvider(new PayPalProvider());

export function getPaymentProvider(gatewayId: GatewayId): PaymentProvider | null {
  return providers.get(gatewayId) || null;
}

export function listRegisteredProviders(): PaymentProvider[] {
  return Array.from(providers.values());
}
