"""Role-based access control (Part 8).

Roles: super_admin, admin, payment_verifier, support_agent, doctor, patient.
Permission checks are enforced on the backend for every route — hiding
frontend buttons is never the only protection.
"""
from __future__ import annotations

from dataclasses import dataclass

ROLES = ("super_admin", "admin", "payment_verifier", "support_agent", "doctor", "patient")

# Permission matrix: permission -> roles allowed.
PERMISSIONS: dict[str, tuple[str, ...]] = {
    "dashboard.view": ("super_admin", "admin", "payment_verifier", "support_agent"),
    "doctors.manage": ("super_admin", "admin"),
    "clinics.manage": ("super_admin", "admin"),
    "appointments.view_all": ("super_admin", "admin", "support_agent"),
    "appointments.manage": ("super_admin", "admin"),
    "payments.view": ("super_admin", "admin", "payment_verifier"),
    "payments.verify": ("super_admin", "payment_verifier"),
    "payments.refund": ("super_admin", "payment_verifier"),
    "whatsapp.manage": ("super_admin", "admin"),
    "patients.view": ("super_admin", "admin", "support_agent"),
    "users.manage": ("super_admin",),
    "settings.manage": ("super_admin", "admin"),
    "audit.view": ("super_admin", "admin"),
    "doctor.own": ("doctor",),
    "patient.own": ("patient",),
}


@dataclass
class Principal:
    user_id: int
    email: str
    role: str
    full_name: str = ""
    doctor_id: int | None = None

    def can(self, permission: str) -> bool:
        return self.role in PERMISSIONS.get(permission, ())


class AuthError(Exception):
    def __init__(self, message: str, status: int = 401):
        super().__init__(message)
        self.status = status


def require(principal: Principal | None, permission: str) -> None:
    if principal is None:
        raise AuthError("Authentication required", 401)
    if not principal.can(permission):
        raise AuthError("Forbidden", 403)
