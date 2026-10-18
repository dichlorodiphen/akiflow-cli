# Akiflow CLI - API Integration Guide

## Overview

This document describes how to integrate with the Akiflow API using the AkiflowClient.

## Authentication

The CLI uses browser-based token extraction to authenticate with Akiflow:

- Discovers Chrome, Arc, Brave, Edge, Firefox, and Safari profiles on macOS
- Explicit `af auth login` scans supported cookie/IndexedDB storage for Akiflow JWT tokens
- Saves credentials in `$AF_CONFIG_DIR/credentials.json` (default `~/.config/af/credentials.json`), atomically with mode 0600. The macOS Keychain is read only to decrypt supported Chrome-family cookies; CLI credentials are not stored there.

## API Methods

### getTasks()

Retrieves one paginated task response. Use `getAllTasks()` for a complete traversal; malformed/non-advancing pagination throws instead of returning partial results.

### upsertTasks(tasks)

Creates or updates tasks in Akiflow.

### getLabels()

Retrieves all labels.

### getTags()

Retrieves all tags.

### getTimeSlots()

Retrieves all time slots.

## Request bounds and HTTP errors

API calls and OAuth refresh use a 30-second timeout. Set
`AF_REQUEST_TIMEOUT_MS` to a positive millisecond value to override it; invalid
values use the default. Timeout messages include the method and path.
Non-authentication HTTP failures expose `HttpError` (`NetworkError`) with
`status`, `path`, and the raw `responseBody`. A 401 shares token renewal across
concurrent requests, then checks for credentials rotated on disk before one
guarded retry. Credential replacement uses an atomic rename.
