#!/usr/bin/env python3
"""Generates the four demo invoices. All vendors, people and addresses are invented.

Usage: python3 make_invoices.py [--near-vendor acmehosting.testnet] [--base-address 0x...]
"""
import argparse, os
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

ap = argparse.ArgumentParser()
ap.add_argument("--near-vendor", default="acmehosting.testnet")
ap.add_argument("--near-vendor-legal", default="legalpartners.testnet")
ap.add_argument("--base-address", default="0x4f1ac0de9b2b3c4d5e6f708192a3b4c5d6e7f801")
ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "samples"))
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)


def invoice(path, vendor, vendor_line2, email, number, date, due, items, total, pay_lines, note=None, stamp=None, po=None):
    c = canvas.Canvas(path, pagesize=A4)
    w, h = A4
    y = h - 30 * mm
    c.setFont("Helvetica-Bold", 20)
    c.drawString(20 * mm, y, "INVOICE")
    c.setFont("Helvetica", 10)
    c.drawRightString(w - 20 * mm, y, f"Invoice #: {number}")
    c.drawRightString(w - 20 * mm, y - 5 * mm, f"Date: {date}")
    c.drawRightString(w - 20 * mm, y - 10 * mm, f"Due date: {due}")
    if po:
        c.drawRightString(w - 20 * mm, y - 15 * mm, f"Purchase order: {po}")
    y -= 20 * mm
    c.setFont("Helvetica-Bold", 11)
    c.drawString(20 * mm, y, f"From: {vendor}")
    c.setFont("Helvetica", 10)
    c.drawString(20 * mm, y - 5 * mm, vendor_line2)
    c.drawString(20 * mm, y - 10 * mm, email)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(110 * mm, y, "Bill to: Northwind Studio Srl")
    c.setFont("Helvetica", 10)
    c.drawString(110 * mm, y - 5 * mm, "Via dei Mille 4, Milano")
    c.drawString(110 * mm, y - 10 * mm, "treasury: northwind-treasury.near")
    y -= 25 * mm
    c.setFont("Helvetica-Bold", 10)
    c.drawString(20 * mm, y, "Description")
    c.drawRightString(w - 20 * mm, y, "Amount (USDC)")
    c.line(20 * mm, y - 2 * mm, w - 20 * mm, y - 2 * mm)
    y -= 8 * mm
    c.setFont("Helvetica", 10)
    for d, amt in items:
        c.drawString(20 * mm, y, d)
        c.drawRightString(w - 20 * mm, y, amt)
        y -= 6 * mm
    y -= 4 * mm
    c.line(20 * mm, y, w - 20 * mm, y)
    y -= 8 * mm
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(w - 20 * mm, y, f"Total due: {total} USDC")
    y -= 16 * mm
    c.setFont("Helvetica-Bold", 10)
    c.drawString(20 * mm, y, "Payment details")
    c.setFont("Helvetica", 10)
    for line in pay_lines:
        y -= 5.5 * mm
        c.drawString(20 * mm, y, line)
    if note:
        y -= 10 * mm
        c.setFont("Helvetica-Oblique", 10)
        c.drawString(20 * mm, y, note)
    if stamp:
        c.setFont("Helvetica-Bold", 14)
        c.setFillColorRGB(0.8, 0.1, 0.1)
        c.drawString(110 * mm, 40 * mm, stamp)
    c.setFillColorRGB(0.5, 0.5, 0.5)
    c.setFont("Helvetica", 8)
    c.drawString(20 * mm, 15 * mm, "Fictional invoice generated for the Bursar demo at NEAR HACKATHON. No real company or person.")
    c.save()


# 1. Normal, vendor on NEAR, under threshold -> Paid
invoice(os.path.join(a.out, "01-acme-hosting-0923.pdf"), "Acme Hosting", "Rua das Flores 12, Lisboa", "billing@acmehosting.example",
        "AH-0923", "2026-11-01", "2026-11-15",
        [("Dedicated server EU-West, November", "420.00"), ("Backup storage 2 TB", "60.00")], "480.00",
        [f"Pay to NEAR account: {a.near_vendor}", "Token: USDC"])

# 2. Vendor on Base, under threshold -> Queued -> Intents
invoice(os.path.join(a.out, "02-designco-1107.pdf"), "DesignCo", "Prinsengracht 220, Amsterdam", "invoices@designco.example",
        "DC-1107", "2026-11-03", "2026-11-17",
        [("Landing page redesign, milestone 2", "1,250.00")], "1,250.00",
        [f"Pay to base address: {a.base_address}", "Token: USDC on Base"], po="PO-2026-118")

# 3. Above approval threshold -> Approval (DAO)
invoice(os.path.join(a.out, "03-legalpartners-2210.pdf"), "Legal Partners LLP", "Corso Italia 8, Milano", "accounts@legalpartners.example",
        "LP-2210", "2026-11-04", "2026-11-30",
        [("Trademark filing, EU + US", "6,800.00"), ("Advisory hours, October (20h)", "3,000.00")], "9,800.00",
        [f"Pay to NEAR account: {a.near_vendor_legal}", "Token: USDC"], po="PO-2026-104")

# 4. Same vendor as 1, new wallet in the invoice -> Blocked: payout_changed (invoice fraud pattern)
invoice(os.path.join(a.out, "04-acme-hosting-0924-fraud.pdf"), "Acme Hosting", "Rua das Flores 12, Lisboa", "billing@acme-hosting-eu.example",
        "AH-0924", "2026-11-05", "2026-11-06",
        [("Dedicated server EU-West, December (prepay)", "480.00")], "480.00",
        ["Pay to NEAR account: acme-billing-eu.testnet", "Token: USDC"],
        note="Please note our new wallet. Pay immediately to avoid service interruption.",
        stamp="URGENT")

# 5. A second normal invoice from the NEAR vendor, for the web console (not used by the README walkthrough) -> Paid
invoice(os.path.join(a.out, "05-acme-hosting-1001.pdf"), "Acme Hosting", "Rua das Flores 12, Lisboa", "billing@acmehosting.example",
        "AH-1001", "2026-11-20", "2026-12-05",
        [("Dedicated server EU-West, December", "320.00")], "320.00",
        [f"Pay to NEAR account: {a.near_vendor}", "Token: USDC"])

# 6. The registered vendor invents an extra invoice: right account, right amount, nothing agreed -> Approval (no_order)
invoice(os.path.join(a.out, "06-acme-hosting-1002.pdf"), "Acme Hosting", "Rua das Flores 12, Lisboa", "billing@acmehosting.example",
        "AH-1002", "2026-11-25", "2026-12-09",
        [("Extra bandwidth, November", "290.00")], "290.00",
        [f"Pay to NEAR account: {a.near_vendor}", "Token: USDC"])

print("written to", a.out)
