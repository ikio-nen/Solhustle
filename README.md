# Solhustle ⚡

> **Decentralized Solana Escrow Freelance Marketplace**  
> Trustless milestone payments, live SOL/USD price conversion via Gemini, on-chain escrow custody, and instant release to freelancers on Solana Devnet.

---

## 🌟 Key Features

- **🔐 Real On-Chain Escrow Accounts**: Every contract provisions a unique escrow account on Solana Devnet. Funds are held trustlessly on-chain until the buyer approves delivery.
- **⚡ In-Browser Ed25519 Signer**: No browser wallet extensions needed for demo — sign and broadcast real Solana transactions directly with built-in cryptographic keypairs.
- **📈 Gemini Live Pricing Oracle**: Real-time SOL/USD price feeds with automated lamport budget computation.
- **🔄 Instant Settlement & Audit Trail**: Fast non-blocking release transfers with direct Solscan transaction receipt verification.
- **🗄️ Resilient Architecture**: SQLite local database synced to **Neon Serverless PostgreSQL (AWS us-east-2)** with automated reconciliations.
- **👥 Role-Based Portals**:
  - **Buyer Portal (`/buyer`)**: Post jobs with USD budgets, fund escrows on Devnet, review applicant proposals, verify milestone deliverables, release payouts.
  - **Seller Portal (`/seller`)**: Browse open funded jobs, submit milestone deliverables with proof links, receive instant SOL transfers.
  - **Admin & Arbitration (`/admin`)**: System health, on-chain vault reconciliation, dispute mediation.

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Ensure your `.env` contains:
```env
PORT=8787
CHAIN=devnet
DATABASE_URL=postgresql://...
```

### 3. Run the Server
```bash
npm start
```
The server will start on `http://localhost:8787`.

---

## 🔑 Demo Credentials

| Role | Username | Password | Access Portal |
|------|----------|----------|---------------|
| **Buyer** | `buyer` | `buyer123` | `http://localhost:8787/buyer` |
| **Seller** | `seller` | `seller123` | `http://localhost:8787/seller` |
| **Admin** | `admin` | `admin 123` | `http://localhost:8787/admin` |

---

## ⛓️ Solana Devnet Architecture

1. **Escrow Funding**: Buyer signs a `SystemProgram.transfer` into the generated contract escrow account.
2. **Milestone Review**: Seller delivers GitHub PR or demo link.
3. **Escrow Release**: Escrow signs 100% transfer of vault balance to freelancer, platform sponsors transaction fee (clean zero-balance account closure without rent exemption simulation failure).
4. **Audit**: Every transaction is indexed with on-chain signatures linked directly to [Solscan Devnet](https://solscan.io/?cluster=devnet).

---

## 🛠️ Tech Stack

- **Blockchain**: Solana (`@solana/web3.js`, `tweetnacl`, `bs58`)
- **Backend**: Node.js 24 ESM, Express, SQLite (`node:sqlite`)
- **Cloud Database**: Neon PostgreSQL (AWS us-east-2)
- **Frontend**: Vanilla JS, Framer-inspired minimalist UI, CSS tokens
- **Oracles**: Gemini Market Ticker API
