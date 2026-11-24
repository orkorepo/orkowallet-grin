package io.orkoswap.orkowallet

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Fingerprint unlock. The wallet password is encrypted with an AES key that lives in the Android Keystore and
 * can only be used right after a successful fingerprint check (the key never leaves the secure hardware and is
 * dropped by Android when a new fingerprint is added). Only the encrypted bytes are stored, per wallet.
 * The password itself always keeps working; this is a convenience on top of it.
 */
class BioLock(private val activity: FragmentActivity) {
  private val prefs = activity.getSharedPreferences("orko_bio", Context.MODE_PRIVATE)

  private fun alias(id: String) = "orko_bio_" + id.filter { it.isLetterOrDigit() || it == '-' || it == '_' }

  fun available(): Boolean =
    BiometricManager.from(activity).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
      BiometricManager.BIOMETRIC_SUCCESS

  fun has(id: String): Boolean = prefs.contains(alias(id)) && key(id) != null

  fun remove(id: String) {
    prefs.edit().remove(alias(id)).apply()
    try {
      KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias(id))
    } catch (_: Exception) { }
  }

  private fun key(id: String): SecretKey? = try {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    ks.getKey(alias(id), null) as? SecretKey
  } catch (_: Exception) { null }

  private fun newKey(id: String): SecretKey {
    val b = KeyGenParameterSpec.Builder(alias(id), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= 30) {
      b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    }
    val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    g.init(b.build())
    return g.generateKey()
  }

  private fun prompt(title: String, cancel: String, cipher: Cipher, done: (Cipher?) -> Unit) {
    val info = BiometricPrompt.PromptInfo.Builder()
      .setTitle(title)
      .setNegativeButtonText(cancel)
      .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      .setConfirmationRequired(false)
      .build()
    val p = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(result.cryptoObject?.cipher)
      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = done(null)
    })
    p.authenticate(info, BiometricPrompt.CryptoObject(cipher))
  }

  /** Remember `secret` for wallet `id` after one fingerprint check. done(true) when stored. */
  fun enroll(id: String, secret: String, title: String, cancel: String, done: (Boolean) -> Unit) {
    try {
      remove(id)
      val k = newKey(id)
      val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, k) }
      prompt(title, cancel, c) { cc ->
        if (cc == null) { remove(id); done(false); return@prompt }
        try {
          val ct = cc.doFinal(secret.toByteArray(Charsets.UTF_8))
          val blob = Base64.encodeToString(cc.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
          prefs.edit().putString(alias(id), blob).apply()
          done(true)
        } catch (_: Exception) { remove(id); done(false) }
      }
    } catch (_: Exception) { remove(id); done(false) }
  }

  /** One fingerprint check, then the stored secret (null when cancelled, failed or no longer valid). */
  fun unlock(id: String, title: String, cancel: String, done: (String?) -> Unit) {
    val blob = prefs.getString(alias(id), null)
    val k = key(id)
    if (blob == null || k == null) { remove(id); done(null); return }
    try {
      val (iv, ct) = blob.split(":").map { Base64.decode(it, Base64.NO_WRAP) }
      val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, iv)) }
      prompt(title, cancel, c) { cc ->
        try { done(cc?.doFinal(ct)?.toString(Charsets.UTF_8)) } catch (_: Exception) { done(null) }
      }
    } catch (_: Exception) {
      // The key was dropped by Android (a new fingerprint was added): the stored bytes are useless now.
      remove(id); done(null)
    }
  }
}
