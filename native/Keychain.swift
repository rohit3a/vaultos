import Foundation
import Security

// Input arrives on stdin so passwords are never included in process arguments.
struct Request: Decodable { let action: String; let service: String; let password: String? }
func fail(_ status: OSStatus) -> Never {
    FileHandle.standardError.write(Data("Keychain status: \(status)\n".utf8))
    exit(3)
}
func finish(_ result: [String: String]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
}
do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 16384 else { exit(2) }
    let request = try JSONDecoder().decode(Request.self, from: data)
    guard request.service.hasPrefix("org.vaultos.preview."), request.service.count < 128 else { exit(2) }
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: request.service, kSecAttrAccount as String: "master-password"]
    #if VAULTOS_TEST
    guard request.service.hasPrefix("org.vaultos.preview.test."),
          let keychainPath = ProcessInfo.processInfo.environment["VAULTOS_TEST_KEYCHAIN"] else { exit(2) }
    var keychain: SecKeychain?
    let opened = SecKeychainOpen(keychainPath, &keychain)
    guard opened == errSecSuccess, let keychain = keychain else { fail(opened) }
    query[kSecMatchSearchList as String] = [keychain]
    #endif
    switch request.action {
    case "get":
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { try finish([:]) }
        else {
            guard status == errSecSuccess, let bytes = result as? Data,
                  let password = String(data: bytes, encoding: .utf8) else { fail(status) }
            try finish(["password": password])
        }
    case "set":
        guard let password = request.password, let bytes = password.data(using: .utf8) else { exit(2) }
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
        if status == errSecItemNotFound {
            var q = query
            #if VAULTOS_TEST
            q.removeValue(forKey: kSecMatchSearchList as String)
            q[kSecUseKeychain as String] = keychain
            #endif
            q[kSecValueData as String] = bytes
            let added = SecItemAdd(q as CFDictionary, nil)
            guard added == errSecSuccess else { fail(added) }
        } else if status != errSecSuccess { fail(status) }
        try finish(["ok": "true"])
    case "delete":
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { fail(status) }
        try finish(["ok": "true"])
    default: exit(2)
    }
} catch { exit(2) }
