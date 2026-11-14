export interface InitParams {
  method?: string; customerEmail?: string; cancelUrl?: string;
  ref: string; amount: number; currency: string; description: string; channels: 'ALL' | 'MOBILE_MONEY' | 'CREDIT_CARD' | 'WALLET';
  notifyUrl: string; returnUrl: string;
  customer?: { name: string; surname: string; email: string; phone: string; address: string; city: string; country: string; zip: string };
}
export interface VerifyResult { status: 'ACCEPTED' | 'REFUSED' | 'PENDING'; amount?: number; currency?: string; method?: string; raw: unknown }

export interface PaymentProvider {
  readonly name: 'cinetpay' | 'stripe' | 'mock';
  init(p: InitParams): Promise<{ paymentUrl: string; token?: string }>;
  verify(ref: string): Promise<VerifyResult>;
}

export interface PayoutRequest { ref: string; amount: number; prefix: string; phone: string; notifyUrl: string; walletHint?: string }
export interface PayoutSendResult { ok: boolean; providerRef?: string; error?: string; raw?: unknown }
export interface PayoutCheckResult { state: 'confirmed' | 'pending' | 'failed'; detail?: string; raw?: unknown }

export interface PayoutProvider {
  readonly name: 'cinetpay' | 'mock';
  send(r: PayoutRequest): Promise<PayoutSendResult>;
  check(ref: string): Promise<PayoutCheckResult>;
}
