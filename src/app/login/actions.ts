'use server';

import { signIn } from '@/auth';

export async function credentialsSignIn(formData: FormData): Promise<void> {
  // callbackUrl is embedded as a hidden form field by the login page
  const callbackUrl = (formData.get('callbackUrl') as string | null) ?? '/';
  await signIn('credentials', formData, { redirectTo: callbackUrl });
}

export async function oidcSignIn(): Promise<void> {
  await signIn('oidc', { redirectTo: '/' });
}
