# Supplier Security Agreement — Microsoft Azure AD / Microsoft 365 SSO
**Document ID:** ISMS-SUP-001  
**Version:** 1.0  
**Status:** Draft — pending legal review  
**Owner:** [REPLACE: CISO / Procurement]  
**Service:** Microsoft Azure Active Directory (Entra ID) — SSO authentication  
**Agreement type:** Reference to Microsoft's standard DPA and compliance certifications

---

## 1. Service Description

Microsoft Azure AD is used as an optional identity provider for Microsoft 365 SSO logins. The CMDB platform receives ID tokens signed by Microsoft's JWKS endpoint after OAuth 2.0 PKCE flow.

## 2. Data Processed by the Supplier

| Data element | Purpose | Retention by supplier |
|-------------|---------|----------------------|
| User email address | Identity assertion in ID token | Per Microsoft Privacy Policy |
| Azure Object ID (OID) | Stable external identifier | Per Microsoft Privacy Policy |
| Tenant ID | Multi-tenant isolation | Per Microsoft Privacy Policy |

No passwords or CMDB asset data are transmitted to Microsoft.

## 3. Compliance Certifications (Microsoft)

Microsoft Azure holds the following certifications relevant to this deployment:
- ISO/IEC 27001:2022 ✅
- ISO/IEC 27017 (Cloud Security) ✅
- ISO/IEC 27018 (Cloud Privacy) ✅
- SOC 2 Type II ✅
- GDPR Data Processing Agreement (Microsoft DPA) ✅

Reference: [Microsoft Trust Center](https://www.microsoft.com/en-us/trust-center)  
Microsoft DPA: [https://www.microsoft.com/en-us/licensing/product-licensing/products](https://www.microsoft.com/en-us/licensing/product-licensing/products)

## 4. Security Requirements Confirmed

- [x] JWKS signature validation enforced on every ID token (backend validates `tid`, `iss`, `aud`, `nonce`)
- [x] Allowed domain restriction (`AZURE_ALLOWED_DOMAIN` env var) prevents cross-tenant logins
- [x] State parameter (CSRF) validated server-side — client-supplied state is never trusted
- [x] SSO access can be revoked by disabling the Azure App Registration

## 5. Incident Notification

In the event of a Microsoft security incident affecting Azure AD, [REPLACE: CISO] will be notified via the Microsoft Service Health Dashboard. The CMDB platform ADMIN accounts will be audited and SSO access suspended if compromise is suspected.

## 6. Exit Strategy

If the Azure AD integration is terminated:
1. Set `USE_MICROSOFT_SSO=false` and restart the backend container
2. SSO-provisioned user accounts retain their VIEWER role but can no longer login via SSO
3. Admin creates local passwords for any affected users who need continued access

**[REPLACE: Signature block with date, organization name, and authorized signatory]**
