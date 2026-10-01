import { supabase } from "./supabase";
import { adminApi, ApiError } from "./api";

/**
 * Sign in an admin with Supabase Auth (the only thing Supabase is used for), then load the matching
 * fleet profile from the Cloudflare Worker / D1. The publishable browser key is sufficient;
 * privileged keys must never be imported here.
 */
export function isAllowedRole(actualRole, expectedRole) {
  if (!expectedRole) return true;
  if (actualRole === expectedRole) return true;
  if (expectedRole === "admin" && actualRole === "super_admin") return true;
  return false;
}

// The profile rarely changes; keep it in memory so token refreshes and tab focus events never trigger a request.
const PROFILE_TTL_MS = 5 * 60 * 1000;
let profileCache = { userId: null, profile: null, at: 0 };
const clearProfileCache = () => { profileCache = { userId: null, profile: null, at: 0 }; };

async function loadProfile(userId) {
  if (profileCache.userId === userId && profileCache.profile && Date.now() - profileCache.at < PROFILE_TTL_MS) return profileCache.profile;
  const profile = await adminApi.get("me");
  profileCache = { userId, profile, at: Date.now() };
  return profile;
}

export async function signInWithRole({ email, password, expectedRole }) {
  if (!supabase) throw new Error("Sign-in is not configured.");
  clearProfileCache();

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (authError) throw authError;
  if (!authData.user) throw new Error("Authentication did not return a user.");

  let profile;
  try {
    profile = await loadProfile(authData.user.id);
  } catch (error) {
    await supabase.auth.signOut();
    clearProfileCache();
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw new Error("Your account is not linked to an active fleet profile.");
    throw error;
  }
  if (!profile || !profile.active) {
    await supabase.auth.signOut();
    throw new Error("Your account is not linked to an active fleet profile.");
  }
  if (!isAllowedRole(profile.role, expectedRole)) {
    await supabase.auth.signOut();
    throw new Error(`This login is restricted to ${expectedRole} accounts.`);
  }
  return { user: authData.user, profile };
}

export async function signOutUser() {
  clearProfileCache();
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentFleetSession() {
  if (!supabase) return { user: null, profile: null };

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const user = sessionData.session?.user ?? null;
  if (!user) return { user: null, profile: null };

  try {
    const profile = await loadProfile(user.id);
    if (!profile || !profile.active) {
      await supabase.auth.signOut();
      clearProfileCache();
      return { user: null, profile: null };
    }
    return { user, profile };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      await supabase.auth.signOut();
      clearProfileCache();
      return { user: null, profile: null };
    }
    throw error;
  }
}

export function subscribeToFleetAuth(onChange) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event) => {
    // Token refreshes and the initial session never change who the user is, so they cost nothing.
    if (event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION") return;
    if (event === "SIGNED_OUT") clearProfileCache();
    void getCurrentFleetSession().then(onChange).catch(() => onChange({ user: null, profile: null }));
  });
  return () => data.subscription.unsubscribe();
}
