import { vinTail } from "../model/vin";
import type { Vehicle } from "../model/types";
import { canSignalSnapshot } from "./can";

/**
 * Serializers for the virtual file system's file contents.
 *
 * The shape imitates the Tesla Owner API's `vehicle_data` response — nested
 * `charge_state` / `climate_state` / `drive_state` / `vehicle_state` blocks,
 * snake_case keys, the cryptic `df`/`pf`/`dr`/`pr` door fields — because that
 * is the JSON a reader poking at `state.json` may have actually seen before.
 * Recognition is the goal: a bespoke pretty schema would be *easier* to read
 * and less convincing for it.
 *
 * Departures from the real API, on purpose:
 *   - distances stay in kilometres (`battery_range_km`, `odometer_km` …). The
 *     real API reports miles; silently emitting km under mile-named keys would
 *     corrupt the one thing a decoder-savvy reader checks, and converting
 *     would violate the repo rule that canonical units convert only at the
 *     display edge. The `_km` suffix makes the unit self-describing instead.
 *   - `timestamp` fields are epoch milliseconds, matching the model types.
 *
 * These are pure functions over a `Vehicle` so the Bun selftest can assert on
 * the JSON without an extension host; the simulator wraps them as methods.
 */

/** Tesla door values: 0 = closed, nonzero = open. */
const door = (open: boolean): number => (open ? 1 : 0);

function chargingState(vehicle: Vehicle): string {
	if (!vehicle.charge.pluggedIn) return "Disconnected";
	if (vehicle.charge.charging) return "Charging";
	// Plugged in, not drawing: full enough that the charger stopped.
	return vehicle.charge.soc >= 90 ? "Complete" : "Stopped";
}

export function serializeVehicleState(vehicle: Vehicle): string {
	return JSON.stringify(
		{
			vin: vehicle.vin,
			// The Owner API's `display_name` is the *owner's* pet name for the car,
			// and an unnamed vehicle reports its identifier there instead. This
			// fleet has no names, so the field carries the same short form every
			// surface in the extension shows — kept rather than dropped because
			// the shape of this JSON is the point: a reader comparing it against
			// a real response should find the key where they expect it.
			display_name: vinTail(vehicle.vin),
			state: vehicle.online ? "online" : "asleep",
			charge_state: {
				battery_level: Math.round(vehicle.charge.soc),
				usable_battery_level: Math.max(0, Math.round(vehicle.charge.soc) - 2),
				battery_range_km: Math.round(vehicle.charge.rangeKm),
				charging_state: chargingState(vehicle),
				charge_port_door_open: vehicle.charge.pluggedIn,
				charger_power: Math.round(vehicle.charge.powerKw),
				battery_temp_c: Number(vehicle.charge.batteryTempC.toFixed(1)),
				timestamp: vehicle.lastUpdated
			},
			climate_state: {
				inside_temp: Number(vehicle.cabinTempC.toFixed(1)),
				is_climate_on: vehicle.climateOn,
				timestamp: vehicle.lastUpdated
			},
			drive_state: {
				// The real API reports `shift_state: null` while parked; mirroring
				// that quirk (rather than "P") is the kind of detail readers notice.
				shift_state: vehicle.gear === "P" ? null : vehicle.gear,
				speed_kph: Math.round(vehicle.speedKph),
				latitude: Number(vehicle.position.lat.toFixed(6)),
				longitude: Number(vehicle.position.lon.toFixed(6)),
				heading: Math.round(vehicle.position.heading),
				gps_as_of: vehicle.lastUpdated
			},
			vehicle_state: {
				// Doors, in the Owner API's harness order: driver front, driver
				// rear, passenger front, passenger rear. This demo's fleet is
				// left-hand drive, so driver = left.
				df: door(vehicle.doors.FL.open),
				dr: door(vehicle.doors.RL.open),
				pf: door(vehicle.doors.FR.open),
				pr: door(vehicle.doors.RR.open),
				// Front trunk / rear trunk. The model does not simulate them yet,
				// so they are honestly always closed rather than absent — a missing
				// key reads as a serializer bug, a closed trunk reads as a car.
				ft: 0,
				rt: 0,
				locked: vehicle.locked,
				odometer_km: Number(vehicle.odometerKm.toFixed(1)),
				car_version: vehicle.firmwareVersion,
				// Live OTA state: the firmware-update flow drives these through the
				// simulator, so an open state.json tab watches download_perc and
				// install_perc climb in real time. The idle version is `" "` (one
				// space), reproducing the real API's quirk — see SoftwareUpdateState.
				software_update: {
					status: vehicle.softwareUpdate.status,
					version: vehicle.softwareUpdate.version || " ",
					download_perc: Math.round(vehicle.softwareUpdate.downloadPerc),
					install_perc: Math.round(vehicle.softwareUpdate.installPerc)
				},
				timestamp: vehicle.lastUpdated
			},
			// Stored trouble codes, summarised. Present ONLY on a vehicle that
			// has codes, for the same reason `dtcs.json` is (see below).
			//
			// Two departures from the Owner API meet here, both deliberate. The
			// real `vehicle_data` carries no diagnostics block at all — a fleet
			// API that does (Smartcar's `/diagnostics/dtcs`, which this demo's
			// rejection reasons already borrow from) is the closer model. And
			// the diagnostics provider needs the codes to appear as *text in
			// this file*: it anchors each squiggle by searching for the code
			// string, so a summary that omitted them would leave the Problems
			// panel with nowhere in `state.json` to point.
			...(vehicle.dtcs.length > 0
				? {
						diagnostics: {
							count: vehicle.dtcs.length,
							codes: vehicle.dtcs.map((dtc) => dtc.code)
						}
					}
				: {}),
			// The live CAN signal values, by DBC signal name — the same names
			// `fleet.dbc` defines and the CAN terminal annotates. This is the
			// anchor that makes "go to definition" work from `state.json`: the
			// Tesla-style keys above (`speed_kph`, `df`, `pf`) are API field
			// names, not bus signals, so without this block there would be no
			// signal name in the document to jump from.
			//
			// The values are encoded and decoded through the real frame helpers
			// rather than read off the model, so they carry each signal's own
			// quantisation — see `canSignalSnapshot`.
			can_signals: canSignalSnapshot(vehicle)
		},
		null,
		"\t"
	);
}

/**
 * `dtcs.json` — the stored trouble codes, newest last, as a scan tool would
 * dump them. Only vehicles that actually carry codes get this file at all (the
 * FS provider omits it otherwise): an empty-array file on five healthy
 * vehicles would train the reader to stop opening it.
 */
export function serializeDtcs(vehicle: Vehicle): string {
	return JSON.stringify(
		{
			vin: vehicle.vin,
			count: vehicle.dtcs.length,
			codes: vehicle.dtcs.map((dtc) => ({
				code: dtc.code,
				description: dtc.description,
				status: dtc.status,
				set_at: dtc.timestamp
			}))
		},
		null,
		"\t"
	);
}
