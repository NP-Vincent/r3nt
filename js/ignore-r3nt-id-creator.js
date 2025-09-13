<script>
function buildBookingMetadata({ id, area, startDate, endDate, landlord, tenant }) {
  return {
    name: `r3nt-SQMU #${id}`,
    description: `Represents ${area} sqm booked from ${startDate} to ${endDate}.`,
    image: "https://sqmu.net/assets/booking-placeholder.png",
    external_url: `https://r3nt.sqmu.net/booking/${id}`,
    attributes: [
      { trait_type: "Area (sqm)", value: area },
      { trait_type: "Start Date", value: startDate },
      { trait_type: "End Date", value: endDate },
      { trait_type: "Landlord", value: landlord },
      { trait_type: "Tenant", value: tenant }
    ]
  };
}

// Example usage:
const bookingData = buildBookingMetadata({
  id: 42,
  area: 60,
  startDate: "2025-10-01",
  endDate: "2025-10-15",
  landlord: "0xLandlordAddress",
  tenant: "0xTenantAddress"
});

console.log(JSON.stringify(bookingData, null, 2));
</script>
